package dnsserver

import (
	"net"
	"testing"
	"time"

	"github.com/miekg/dns"

	"github.com/cofys/callsign/internal/config"
)

func testServer(t *testing.T, dnsPort int) *Server {
	t.Helper()
	store := config.NewStore(t.TempDir() + "/callsign.yaml")
	store.SetRuntimeFlags("cofy", 80, dnsPort, false, false)
	return &Server{
		store:       store,
		lanIP:       net.ParseIP("192.168.1.159").To4(),
		dnsClient:   &dns.Client{Net: "udp", Timeout: 2 * time.Second},
		dnsClientTC: &dns.Client{Net: "tcp", Timeout: 2 * time.Second},
		peerClient:  &dns.Client{Net: "udp", Timeout: peerMissTimeout},
	}
}

func TestPeerForZone(t *testing.T) {
	s := testServer(t, 53)
	s.setPeers([]Peer{
		{IP: "192.168.1.160", Domain: "proj", InstanceID: "cs-b"},
		{IP: "192.168.1.161", Domain: "lab", InstanceID: "cs-c"},
	})

	cases := []struct {
		qname string
		want  string // peer IP, "" for no match
	}{
		{"plex.proj.", "192.168.1.160"},
		{"proj.", "192.168.1.160"},
		{"deep.sub.lab.", "192.168.1.161"},
		{"plex.cofy.", ""},  // own domain is never a peer zone
		{"github.com.", ""}, // public name
		{"notproj.", ""},    // suffix lookalike must not match
		{"fakeproj.", ""},   // ditto
	}
	for _, c := range cases {
		peer, ok := s.peerForZone(c.qname)
		if c.want == "" && ok {
			t.Errorf("peerForZone(%q): got peer %s, want none", c.qname, peer.IP)
		}
		if c.want != "" && (!ok || peer.IP != c.want) {
			t.Errorf("peerForZone(%q): got %v/%v, want %s", c.qname, peer.IP, ok, c.want)
		}
	}
}

// startStubPeer runs a real DNS server that answers A=10.9.9.9 for
// anything under .proj. and NXDOMAIN otherwise.
func startStubPeer(t *testing.T) (ip string, port int) {
	t.Helper()
	mux := dns.NewServeMux()
	mux.HandleFunc(".", func(w dns.ResponseWriter, r *dns.Msg) {
		m := new(dns.Msg)
		m.SetReply(r)
		q := r.Question[0]
		if len(q.Name) > 6 && q.Name[len(q.Name)-6:] == ".proj." {
			m.Answer = append(m.Answer, &dns.A{
				Hdr: dns.RR_Header{Name: q.Name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 60},
				A:   net.ParseIP("10.9.9.9").To4(),
			})
		} else {
			m.SetRcode(r, dns.RcodeNameError)
		}
		_ = w.WriteMsg(m)
	})
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("stub listen: %v", err)
	}
	srv := &dns.Server{PacketConn: pc, Net: "udp", Handler: mux}
	go func() { _ = srv.ActivateAndServe() }()
	t.Cleanup(func() { _ = srv.Shutdown() })
	addr := pc.LocalAddr().(*net.UDPAddr)
	return addr.IP.String(), addr.Port
}

func TestPeerZoneForwardEndToEnd(t *testing.T) {
	stubIP, stubPort := startStubPeer(t)
	s := testServer(t, stubPort)
	s.setPeers([]Peer{{IP: stubIP, Domain: "proj", InstanceID: "cs-stub"}})

	// Zone forwarding: the exact path serveDNS takes for peer zones.
	peer, ok := s.peerForZone("media.proj.")
	if !ok {
		t.Fatal("peerForZone(media.proj.) found no peer")
	}
	q := new(dns.Msg)
	q.SetQuestion("media.proj.", dns.TypeA)
	resp, err := s.exchangePeer(q, peer, s.dnsClient)
	if err != nil {
		// Some sandboxes block UDP replies to ephemeral ports ("sendto:
		// operation not permitted" server-side), making any live DNS
		// exchange untestable there while the code is fine — the same path
		// is exercised for real in the two-daemon botnest proof. Detect
		// that environment with a raw loopback echo and skip only there.
		if udpLoopbackBroken() {
			t.Skipf("live UDP loopback blocked by this environment: %v", err)
		}
		t.Fatalf("exchangePeer: %v", err)
	}
	if len(resp.Answer) != 1 {
		t.Fatalf("expected 1 answer, got %d", len(resp.Answer))
	}
	if a, ok := resp.Answer[0].(*dns.A); !ok || !a.A.Equal(net.ParseIP("10.9.9.9")) {
		t.Fatalf("unexpected answer: %v", resp.Answer[0])
	}

	// Local-miss fallback: unknown .local offered to peers; stub NXDOMAINs
	// .local, so the miss must stay a miss (nil)...
	if got := s.tryPeersForLocalMiss(mkQuery("other.local.")); got != nil {
		t.Fatalf("tryPeersForLocalMiss should be nil on peer NXDOMAIN, got rcode %d", got.Rcode)
	}
	// ...while a .proj. name asked through the miss path gets the peer answer.
	if got := s.tryPeersForLocalMiss(mkQuery("media.proj.")); got == nil || len(got.Answer) != 1 {
		t.Fatalf("tryPeersForLocalMiss(media.proj.) = %v, want the stub answer", got)
	}
}

// udpLoopbackBroken reports whether a trivial UDP echo round-trip on
// 127.0.0.1 fails in this environment (sandbox egress policies can block
// replies to ephemeral ports while leaving real machines unaffected).
func udpLoopbackBroken() bool {
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		return false
	}
	defer pc.Close()
	go func() {
		buf := make([]byte, 64)
		_ = pc.SetReadDeadline(time.Now().Add(2 * time.Second))
		if n, addr, err := pc.ReadFrom(buf); err == nil {
			_, _ = pc.WriteTo(buf[:n], addr)
		}
	}()
	conn, err := net.Dial("udp", pc.LocalAddr().String())
	if err != nil {
		return false
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(600 * time.Millisecond))
	if _, err := conn.Write([]byte("ping")); err != nil {
		return false
	}
	buf := make([]byte, 64)
	_, err = conn.Read(buf)
	return err != nil
}

func mkQuery(name string) *dns.Msg {
	m := new(dns.Msg)
	m.SetQuestion(name, dns.TypeA)
	return m
}
