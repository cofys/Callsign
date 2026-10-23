package dnsserver

import (
	"context"
	"fmt"
	"log"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/miekg/dns"

	"github.com/lanname/lanname/internal/config"
)

const (
	localRecordTTL = 60
	forwardTimeout = 2 * time.Second
)

// Server is an authoritative local DNS server for *.<domain> and <domain>,
// a Browser DoH Canary blocker (use-application-dns.net -> NXDOMAIN),
// and a fast upstream DNS forwarder.
type Server struct {
	store       *config.Store
	lanIP       net.IP
	boundAddrs  []string
	mu          sync.Mutex
	dnsServers  []*dns.Server
	dnsClient   *dns.Client
	dnsClientTC *dns.Client
}

// New creates a new DNS Server backed by the configuration store and primary LAN IPv4.
func New(store *config.Store, lanIP net.IP) *Server {
	return &Server{
		store: store,
		lanIP: lanIP.To4(),
		dnsClient: &dns.Client{
			Net:     "udp",
			Timeout: forwardTimeout,
		},
		dnsClientTC: &dns.Client{
			Net:     "tcp",
			Timeout: forwardTimeout,
		},
	}
}

// Start binds UDP and TCP listeners on <LAN_IP>:<dnsPort>, 127.0.0.1:<dnsPort>,
// and dual-stack IPv6 [::1]:<dnsPort> (gracefully continuing if an address is already in use).
func (s *Server) Start(ctx context.Context) ([]string, error) {
	port := s.store.DNSPort()
	type listenTarget struct {
		udpNet string
		tcpNet string
		addr   string
	}
	candidates := []listenTarget{
		{udpNet: "udp4", tcpNet: "tcp4", addr: fmt.Sprintf("%s:%d", s.lanIP.String(), port)},
	}
	if s.lanIP.String() != "127.0.0.1" {
		candidates = append(candidates, listenTarget{udpNet: "udp4", tcpNet: "tcp4", addr: fmt.Sprintf("127.0.0.1:%d", port)})
	}
	candidates = append(candidates, listenTarget{udpNet: "udp6", tcpNet: "tcp6", addr: fmt.Sprintf("[::1]:%d", port)})

	mux := dns.NewServeMux()
	mux.HandleFunc(".", s.serveDNS)

	var bound []string
	var firstErr error

	for _, c := range candidates {
		udpConn, err := net.ListenPacket(c.udpNet, c.addr)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		tcpLn, tcpErr := net.Listen(c.tcpNet, c.addr)
		if tcpErr != nil {
			_ = udpConn.Close()
			if firstErr == nil {
				firstErr = tcpErr
			}
			continue
		}

		udpSrv := &dns.Server{
			PacketConn: udpConn,
			Net:        "udp",
			Handler:    mux,
		}
		tcpSrv := &dns.Server{
			Listener: tcpLn,
			Net:      "tcp",
			Handler:  mux,
		}

		s.mu.Lock()
		s.dnsServers = append(s.dnsServers, udpSrv, tcpSrv)
		s.boundAddrs = append(s.boundAddrs, c.addr)
		s.mu.Unlock()

		bound = append(bound, c.addr)

		go func(srv *dns.Server) {
			_ = srv.ActivateAndServe()
		}(udpSrv)
		go func(srv *dns.Server) {
			_ = srv.ActivateAndServe()
		}(tcpSrv)
	}

	go func() {
		<-ctx.Done()
		_ = s.Close()
	}()

	if len(bound) == 0 && firstErr != nil {
		return nil, fmt.Errorf("could not bind DNS port %d (%v)", port, firstErr)
	}

	return bound, nil
}

// BoundAddrs returns the list of ip:port addresses successfully bound by the DNS server.
func (s *Server) BoundAddrs() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string{}, s.boundAddrs...)
}

// isPrivateOrLocalClient enforces a strict Private LAN ACL so that even if a router
// accidentally exposes port 53 via UPnP or DMZ, the daemon refuses public internet queries
// and cannot be abused as an open DNS amplification resolver.
func isPrivateOrLocalClient(addr net.Addr) bool {
	if addr == nil {
		return false
	}
	host, _, err := net.SplitHostPort(addr.String())
	if err != nil {
		host = addr.String()
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast()
}

func (s *Server) serveDNS(w dns.ResponseWriter, r *dns.Msg) {
	if len(r.Question) == 0 {
		return
	}

	// Security Hardening: Reject queries originating outside RFC1918 / IPv6 ULA / Loopback / Link-Local
	if !isPrivateOrLocalClient(w.RemoteAddr()) {
		refused := new(dns.Msg)
		refused.SetRcode(r, dns.RcodeRefused)
		_ = w.WriteMsg(refused)
		return
	}

	q := r.Question[0]
	qName := strings.ToLower(q.Name)

	// 1. Browser DoH Canary Protection:
	// Return NXDOMAIN for Mozilla Firefox's canary ("use-application-dns.net.")
	// and DDR discovery ("_dns.resolver.arpa.") so browsers do not bypass local LAN DNS.
	if qName == "use-application-dns.net." ||
		strings.HasSuffix(qName, ".use-application-dns.net.") ||
		qName == "_dns.resolver.arpa." ||
		strings.HasSuffix(qName, "._dns.resolver.arpa.") {
		m := new(dns.Msg)
		m.SetRcode(r, dns.RcodeNameError)
		m.Authoritative = true
		_ = w.WriteMsg(m)
		return
	}

	// 2. Authoritative Local Domain Resolution (*.<domain>. and <domain>. and *.local.):
	domain := s.store.Domain()
	domainFQDN := domain + "."
	domainSuffix := "." + domainFQDN

	if qName == domainFQDN || strings.HasSuffix(qName, domainSuffix) || strings.HasSuffix(qName, ".local.") {
		s.handleAuthoritativeLocal(w, r, q, qName, domainFQDN, domainSuffix)
		return
	}

	// 3. Forward all other queries upstream
	s.forwardUpstream(w, r)
}

func (s *Server) handleAuthoritativeLocal(
	w dns.ResponseWriter,
	r *dns.Msg,
	q dns.Question,
	qName, domainFQDN, domainSuffix string,
) {
	domain := strings.TrimSuffix(domainFQDN, ".")

	m := new(dns.Msg)
	m.SetReply(r)
	m.Authoritative = true
	m.RecursionAvailable = true

	// Cryptographic Instance Identity Probe: _lanname.<domain>. or _lanname.local.
	// Used by the Android VpnService companion app to verify this host is the user's
	// genuine lanname daemon and not a rogue/colliding 192.168.1.x IP on public Wi-Fi.
	isIdentityProbe := qName == "_lanname."+domainFQDN || qName == "_lanname.local."

	// Determine whether the queried name matches the base hub (<domain>.) or a known service (<svc>.<domain>.)
	isKnown := isIdentityProbe
	if !isKnown {
		if qName == domainFQDN || qName == domain+".local." {
			isKnown = true
		} else if strings.HasSuffix(qName, domainSuffix) {
			sub := strings.TrimSuffix(qName, domainSuffix)
			if _, ok := s.store.Get(sub); ok {
				isKnown = true
			}
		} else if strings.HasSuffix(qName, ".local.") {
			sub := strings.TrimSuffix(qName, ".local.")
			if sub == domain {
				isKnown = true
			} else if _, ok := s.store.Get(sub); ok {
				isKnown = true
			}
		}
	}

	if !isKnown {
		// Wildcard fallback: also resolve unknown subdomains of *.<domain>. to LAN_IP
		// so the HTTP reverse proxy can display a helpful 404/dashboard page instead of DNS failure.
		isKnown = strings.HasSuffix(qName, domainSuffix)
	}

	if !isKnown {
		m.SetRcode(r, dns.RcodeNameError)
		_ = w.WriteMsg(m)
		return
	}

	switch q.Qtype {
	case dns.TypeA, dns.TypeANY:
		m.Answer = append(m.Answer, &dns.A{
			Hdr: dns.RR_Header{
				Name:   q.Name,
				Rrtype: dns.TypeA,
				Class:  dns.ClassINET,
				Ttl:    localRecordTTL,
			},
			A: s.lanIP,
		})
	case dns.TypeAAAA:
		// Return immediate NOERROR with 0 Answer records (NODATA) so dual-stack clients don't stall
		m.Rcode = dns.RcodeSuccess
	case dns.TypeTXT:
		m.Answer = append(m.Answer, &dns.TXT{
			Hdr: dns.RR_Header{
				Name:   q.Name,
				Rrtype: dns.TypeTXT,
				Class:  dns.ClassINET,
				Ttl:    localRecordTTL,
			},
			Txt: []string{
				"lanname-daemon=active",
				"lanname-instance=" + s.store.InstanceID(),
				"lanname-domain=" + domain,
			},
		})
	default:
		m.Rcode = dns.RcodeSuccess
	}

	_ = w.WriteMsg(m)
}

func (s *Server) forwardUpstream(w dns.ResponseWriter, r *dns.Msg) {
	upstreams := s.store.Upstreams()
	for _, upstream := range upstreams {
		target := upstream
		if !strings.Contains(target, ":") {
			target = net.JoinHostPort(target, "53")
		}

		resp, _, err := s.dnsClient.Exchange(r, target)
		if err == nil && resp != nil && resp.Truncated {
			resp, _, err = s.dnsClientTC.Exchange(r, target)
		}
		if err == nil && resp != nil {
			_ = w.WriteMsg(resp)
			return
		}
	}

	fail := new(dns.Msg)
	fail.SetRcode(r, dns.RcodeServerFailure)
	if err := w.WriteMsg(fail); err != nil {
		log.Printf("[dns] failed writing SERVFAIL: %v", err)
	}
}

// Close shuts down all active UDP and TCP DNS listeners.
func (s *Server) Close() error {
	s.mu.Lock()
	servers := append([]*dns.Server{}, s.dnsServers...)
	s.dnsServers = nil
	s.mu.Unlock()

	var lastErr error
	for _, srv := range servers {
		if err := srv.Shutdown(); err != nil {
			lastErr = err
		}
	}
	return lastErr
}
