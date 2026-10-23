package mdns

import (
	"context"
	"fmt"
	"log"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/miekg/dns"
	"golang.org/x/net/ipv4"

	"github.com/lanname/lanname/internal/netutil"
)

const (
	mdnsGroupIPv4 = "224.0.0.251"
	mdnsPort      = 5353
	defaultTTL    = 120
	cacheFlushBit = 0x8000
)

var mdnsMulticastAddr = &net.UDPAddr{
	IP:   net.ParseIP(mdnsGroupIPv4),
	Port: mdnsPort,
}

// Responder is a multi-alias RFC 6762 Multicast DNS responder on UDP 5353.
// Unlike standard single-hostname mDNS libraries, Responder answers for an arbitrary
// dynamic set of <service>.local. and <domain>.local. hostnames simultaneously,
// including immediate AAAA NODATA synthesis to prevent 5-second dual-stack delays.
type Responder struct {
	lanIP   net.IP
	mu      sync.RWMutex
	hosts   map[string]bool // FQDNs in lowercase with trailing dot, e.g., "hq.local."
	pconn   *ipv4.PacketConn
	udpConn *net.UDPConn
	ifaces  []net.Interface
	closed  chan struct{}
}

// NewResponder creates a new multi-alias mDNS responder bound to 0.0.0.0:5353.
func NewResponder(lanIP net.IP, hostnames []string) (*Responder, error) {
	ip4 := lanIP.To4()
	if ip4 == nil {
		return nil, fmt.Errorf("mDNS responder requires a valid IPv4 address, got %v", lanIP)
	}

	lc := net.ListenConfig{
		Control: reusePortControl,
	}
	pktConn, err := lc.ListenPacket(context.Background(), "udp4", fmt.Sprintf("0.0.0.0:%d", mdnsPort))
	if err != nil {
		return nil, fmt.Errorf("listen udp4 0.0.0.0:%d: %w", mdnsPort, err)
	}

	udpConn, ok := pktConn.(*net.UDPConn)
	if !ok {
		_ = pktConn.Close()
		return nil, fmt.Errorf("expected *net.UDPConn from ListenPacket")
	}

	pconn := ipv4.NewPacketConn(udpConn)
	_ = pconn.SetMulticastTTL(255)
	_ = pconn.SetMulticastLoopback(true)

	ifaces, err := netutil.MulticastInterfaces()
	if err != nil || len(ifaces) == 0 {
		// Fall back to joining on the default interface (nil)
		if joinErr := pconn.JoinGroup(nil, &net.UDPAddr{IP: net.ParseIP(mdnsGroupIPv4)}); joinErr != nil {
			_ = udpConn.Close()
			return nil, fmt.Errorf("join multicast group 224.0.0.251: %w", joinErr)
		}
	} else {
		joined := 0
		for i := range ifaces {
			if err := pconn.JoinGroup(&ifaces[i], &net.UDPAddr{IP: net.ParseIP(mdnsGroupIPv4)}); err == nil {
				joined++
			}
		}
		if joined == 0 {
			if joinErr := pconn.JoinGroup(nil, &net.UDPAddr{IP: net.ParseIP(mdnsGroupIPv4)}); joinErr != nil {
				_ = udpConn.Close()
				return nil, fmt.Errorf("failed to join 224.0.0.251 on any interface: %w", joinErr)
			}
		}
	}

	r := &Responder{
		lanIP:   ip4,
		hosts:   make(map[string]bool),
		pconn:   pconn,
		udpConn: udpConn,
		ifaces:  ifaces,
		closed:  make(chan struct{}),
	}
	r.SetHostnames(hostnames)
	return r, nil
}

// SetHostnames atomically replaces the set of active .local hostnames and sends gratuitous announcements.
func (r *Responder) SetHostnames(names []string) {
	next := make(map[string]bool, len(names))
	for _, name := range names {
		fqdn := normalizeLocalFQDN(name)
		if fqdn != "" {
			next[fqdn] = true
		}
	}
	r.mu.Lock()
	r.hosts = next
	r.mu.Unlock()

	go r.Announce()
}

// Hostnames returns a sorted snapshot of registered .local FQDNs.
func (r *Responder) Hostnames() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]string, 0, len(r.hosts))
	for h := range r.hosts {
		out = append(out, strings.TrimSuffix(h, "."))
	}
	return out
}

func normalizeLocalFQDN(name string) string {
	clean := strings.ToLower(strings.TrimSpace(name))
	clean = strings.Trim(clean, ".")
	if clean == "" {
		return ""
	}
	if !strings.HasSuffix(clean, ".local") {
		clean = clean + ".local"
	}
	return clean + "."
}

// Start runs the packet read loop until ctx is canceled or Close is called.
func (r *Responder) Start(ctx context.Context) {
	go func() {
		<-ctx.Done()
		_ = r.Close()
	}()

	go r.Announce()

	buf := make([]byte, 65535)
	for {
		n, _, src, err := r.pconn.ReadFrom(buf)
		if err != nil {
			select {
			case <-r.closed:
				return
			default:
				continue
			}
		}
		packet := append([]byte(nil), buf[:n]...)
		r.handlePacket(packet, src)
	}
}

// Announce broadcasts 2 unsolicited gratuitous mDNS announcements (1 second apart)
// for all registered .local hostnames so LAN devices populate or update their caches immediately.
func (r *Responder) Announce() {
	r.mu.RLock()
	names := make([]string, 0, len(r.hosts))
	for fqdn := range r.hosts {
		names = append(names, fqdn)
	}
	r.mu.RUnlock()

	if len(names) == 0 {
		return
	}

	msg := new(dns.Msg)
	msg.MsgHdr.Response = true
	msg.MsgHdr.Authoritative = true

	for _, fqdn := range names {
		msg.Answer = append(msg.Answer, &dns.A{
			Hdr: dns.RR_Header{
				Name:   fqdn,
				Rrtype: dns.TypeA,
				Class:  dns.ClassINET | cacheFlushBit,
				Ttl:    defaultTTL,
			},
			A: r.lanIP,
		})
	}

	wire, err := msg.Pack()
	if err != nil {
		return
	}

	for i := 0; i < 2; i++ {
		select {
		case <-r.closed:
			return
		default:
		}
		r.sendMulticast(wire)
		if i == 0 {
			time.Sleep(1 * time.Second)
		}
	}
}

func (r *Responder) handlePacket(raw []byte, src net.Addr) {
	var req dns.Msg
	if err := req.Unpack(raw); err != nil {
		return
	}

	// Ignore responses; we only answer mDNS queries (OpcodeQuery, Response == false)
	if req.Response || req.Opcode != dns.OpcodeQuery || len(req.Question) == 0 {
		return
	}

	var unicastAnswers []dns.RR
	var multicastAnswers []dns.RR
	matchedAnyQuestion := false
	unicastRequested := false

	r.mu.RLock()
	for _, q := range req.Question {
		qName := strings.ToLower(q.Name)
		if !r.hosts[qName] {
			continue
		}
		matchedAnyQuestion = true

		// RFC 6762 Section 5.4: top bit of Qclass indicates Unicast Response desired (QU bit)
		wantsUnicast := (q.Qclass & cacheFlushBit) != 0
		qClass := q.Qclass &^ cacheFlushBit
		if qClass != dns.ClassINET && qClass != dns.ClassANY {
			continue
		}
		if wantsUnicast {
			unicastRequested = true
		}

		switch q.Qtype {
		case dns.TypeA, dns.TypeANY:
			rr := &dns.A{
				Hdr: dns.RR_Header{
					Name:   q.Name,
					Rrtype: dns.TypeA,
					Class:  dns.ClassINET | cacheFlushBit,
					Ttl:    defaultTTL,
				},
				A: r.lanIP,
			}
			if wantsUnicast {
				unicastAnswers = append(unicastAnswers, rr)
			} else {
				multicastAnswers = append(multicastAnswers, rr)
			}

		case dns.TypeAAAA:
			// CRITICAL IPv6 Dual-Stack Fix:
			// Dual-stack OS resolvers (macOS, iOS, Linux, Windows) send parallel A and AAAA
			// queries for <name>.local. If we ignore AAAA, clients wait up to 5 seconds
			// for an IPv6 timeout. We immediately return a valid authoritative NOERROR response
			// with 0 Answer records (NODATA) and an NSEC record proving only TypeA exists.
			nsec := &dns.NSEC{
				Hdr: dns.RR_Header{
					Name:   q.Name,
					Rrtype: dns.TypeNSEC,
					Class:  dns.ClassINET | cacheFlushBit,
					Ttl:    defaultTTL,
				},
				NextDomain: q.Name,
				TypeBitMap: []uint16{dns.TypeA},
			}
			if wantsUnicast {
				_ = nsec
			}
		}
	}
	r.mu.RUnlock()

	if !matchedAnyQuestion {
		return
	}

	resp := new(dns.Msg)
	resp.Id = req.Id
	resp.Response = true
	resp.Authoritative = true
	resp.Rcode = dns.RcodeSuccess

	// Include answers if any (for AAAA-only queries, Answer remains empty -> immediate NODATA)
	resp.Answer = append(resp.Answer, unicastAnswers...)
	resp.Answer = append(resp.Answer, multicastAnswers...)

	// Provide negative caching NSEC record in Extra when answering AAAA NODATA
	if len(resp.Answer) == 0 {
		for _, q := range req.Question {
			qName := strings.ToLower(q.Name)
			r.mu.RLock()
			owned := r.hosts[qName]
			r.mu.RUnlock()
			if owned && q.Qtype == dns.TypeAAAA {
				resp.Extra = append(resp.Extra, &dns.NSEC{
					Hdr: dns.RR_Header{
						Name:   q.Name,
						Rrtype: dns.TypeNSEC,
						Class:  dns.ClassINET | cacheFlushBit,
						Ttl:    defaultTTL,
					},
					NextDomain: q.Name,
					TypeBitMap: []uint16{dns.TypeA},
				})
			}
		}
	}

	wire, err := resp.Pack()
	if err != nil {
		log.Printf("[mdns] pack error: %v", err)
		return
	}

	// Send unicast reply directly to requester if QU bit was set or source port != 5353
	udpSrc, isUDP := src.(*net.UDPAddr)
	if unicastRequested || (isUDP && udpSrc.Port != mdnsPort) {
		_, _ = r.udpConn.WriteToUDP(wire, udpSrc)
		if len(multicastAnswers) == 0 {
			return
		}
	}

	r.sendMulticast(wire)
}

func (r *Responder) sendMulticast(wire []byte) {
	if len(r.ifaces) == 0 {
		_, _ = r.pconn.WriteTo(wire, nil, mdnsMulticastAddr)
		return
	}
	for i := range r.ifaces {
		_ = r.pconn.SetMulticastInterface(&r.ifaces[i])
		_, _ = r.pconn.WriteTo(wire, nil, mdnsMulticastAddr)
	}
}

// Close sends a goodbye (TTL=0) packet and closes the UDP multicast socket.
func (r *Responder) Close() error {
	select {
	case <-r.closed:
		return nil
	default:
		close(r.closed)
	}

	// Best-effort RFC 6762 goodbye announcement (TTL = 0)
	r.mu.RLock()
	msg := new(dns.Msg)
	msg.Response = true
	msg.Authoritative = true
	for fqdn := range r.hosts {
		msg.Answer = append(msg.Answer, &dns.A{
			Hdr: dns.RR_Header{
				Name:   fqdn,
				Rrtype: dns.TypeA,
				Class:  dns.ClassINET | cacheFlushBit,
				Ttl:    0,
			},
			A: r.lanIP,
		})
	}
	r.mu.RUnlock()

	if len(msg.Answer) > 0 {
		if wire, err := msg.Pack(); err == nil {
			r.sendMulticast(wire)
		}
	}

	return r.udpConn.Close()
}
