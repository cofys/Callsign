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

// Start binds UDP and TCP listeners on <LAN_IP>:<dnsPort> and attempts 127.0.0.1:<dnsPort>
// (gracefully continuing if 127.0.0.1:53 is already in use or if unprivileged).
func (s *Server) Start(ctx context.Context) ([]string, error) {
	port := s.store.DNSPort()
	candidates := []string{
		fmt.Sprintf("%s:%d", s.lanIP.String(), port),
	}
	if s.lanIP.String() != "127.0.0.1" {
		candidates = append(candidates, fmt.Sprintf("127.0.0.1:%d", port))
	}

	mux := dns.NewServeMux()
	mux.HandleFunc(".", s.serveDNS)

	var bound []string
	var firstErr error

	for _, addr := range candidates {
		udpConn, err := net.ListenPacket("udp4", addr)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		tcpLn, tcpErr := net.Listen("tcp4", addr)
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
		s.boundAddrs = append(s.boundAddrs, addr)
		s.mu.Unlock()

		bound = append(bound, addr)

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

func (s *Server) serveDNS(w dns.ResponseWriter, r *dns.Msg) {
	if len(r.Question) == 0 {
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

	// Determine whether the queried name matches the base hub (<domain>.) or a known service (<svc>.<domain>.)
	isKnown := false
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
			Txt: []string{"lanname-daemon=active"},
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
