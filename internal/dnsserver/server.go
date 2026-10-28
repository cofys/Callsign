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

	"github.com/cofys/callsign/internal/config"
	"github.com/cofys/callsign/internal/netutil"
)

const (
	localRecordTTL = 60
	forwardTimeout = 2 * time.Second
)

// Server is an authoritative local & Tailscale Split-Horizon DNS server for *.<domain> and <domain>,
// a Browser DoH Canary blocker (use-application-dns.net -> NXDOMAIN),
// and a fast upstream DNS forwarder.
type Server struct {
	store       *config.Store
	lanIP       net.IP
	tailscaleIP net.IP
	boundAddrs  []string
	mu          sync.Mutex
	dnsServers  []*dns.Server
	dnsClient   *dns.Client
	dnsClientTC *dns.Client
}

// New creates a new DNS Server backed by the configuration store, primary LAN IPv4, and optional Tailscale IPv4.
func New(store *config.Store, lanIP net.IP) *Server {
	tsIP, _ := netutil.TailscaleIPv4()
	return &Server{
		store:       store,
		lanIP:       lanIP.To4(),
		tailscaleIP: tsIP,
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

// Start binds UDP and TCP listeners on <LAN_IP>:<dnsPort>, <TAILSCALE_IP>:<dnsPort> (if active),
// 127.0.0.1:<dnsPort>, and dual-stack IPv6 [::1]:<dnsPort>.
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
	if s.tailscaleIP != nil && !s.tailscaleIP.Equal(s.lanIP) {
		candidates = append(candidates, listenTarget{
			udpNet: "udp4",
			tcpNet: "tcp4",
			addr:   fmt.Sprintf("%s:%d", s.tailscaleIP.String(), port),
		})
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

// isPrivateOrLocalClient enforces a strict Private LAN + Tailscale CGNAT ACL so that even if
// a router accidentally exposes port 53 via UPnP or DMZ, the daemon refuses public internet queries.
func isPrivateOrLocalClient(addr net.Addr) bool {
	ip := extractRemoteIP(addr)
	if ip == nil {
		return false
	}
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || netutil.IsTailscaleIP(ip)
}

func extractRemoteIP(addr net.Addr) net.IP {
	if addr == nil {
		return nil
	}
	host, _, err := net.SplitHostPort(addr.String())
	if err != nil {
		host = addr.String()
	}
	return net.ParseIP(host)
}

// answerIPForClient implements Split-Horizon DNS:
// - Queries arriving from a Tailscale peer (100.64.0.0/10 or fd7a:115c:a1e0::/48) receive the host's Tailscale IPv4.
// - Queries arriving from the local LAN receive the host's direct LAN IPv4.
func (s *Server) answerIPForClient(addr net.Addr) net.IP {
	remoteIP := extractRemoteIP(addr)
	if s.tailscaleIP != nil && netutil.IsTailscaleIP(remoteIP) {
		return s.tailscaleIP
	}
	return s.lanIP
}

func (s *Server) serveDNS(w dns.ResponseWriter, r *dns.Msg) {
	if len(r.Question) == 0 {
		return
	}

	// Security Hardening: Reject queries originating outside RFC1918 / Tailscale CGNAT / IPv6 ULA / Loopback
	if !isPrivateOrLocalClient(w.RemoteAddr()) {
		refused := new(dns.Msg)
		refused.SetRcode(r, dns.RcodeRefused)
		_ = w.WriteMsg(refused)
		return
	}

	q := r.Question[0]
	qName := strings.ToLower(q.Name)

	// 1. Browser DoH Canary Protection:
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

	// Cryptographic Instance Identity Probe: _callsign.<domain>. or _callsign.local.
	isIdentityProbe := qName == "_callsign."+domainFQDN || qName == "_callsign.local." ||
		qName == "_lanname."+domainFQDN || qName == "_lanname.local."

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
			A: s.answerIPForClient(w.RemoteAddr()),
		})
	case dns.TypeAAAA:
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
				"callsign-daemon=active",
				"callsign-instance=" + s.store.InstanceID(),
				"callsign-domain=" + domain,
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
