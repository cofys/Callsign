package dnsserver

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/miekg/dns"
)

// Peer is a sibling Callsign daemon on the LAN that owns a different custom
// domain. Multi-daemon households run one daemon per box/project; peers let
// any single daemon resolve EVERY daemon's names, so clients (phones,
// laptops) only ever need one daemon's address:
//
//   - A query under a peer's domain is forwarded to that peer verbatim.
//   - A `.local` name this daemon doesn't know is offered to each peer
//     before answering NXDOMAIN (every daemon serves its own services
//     under `.local`). Queries that arrive FROM a peer are never
//     re-forwarded — one hop maximum, so forwarding can't loop.
//
// Peers come from static config (`peers:` in callsign.yaml) plus automatic
// discovery: a periodic /24 scan for the same `/api/identity` endpoint the
// Android companion's Auto-Discover uses.
type Peer struct {
	IP         string
	Domain     string // without dots, e.g. "proj"
	InstanceID string // "" for statically configured peers
}

const (
	peerDiscoveryInterval = 60 * time.Second
	peerProbeTimeout      = 700 * time.Millisecond
	peerMissTimeout       = 500 * time.Millisecond
)

// peerSnapshot returns the current peer table (discovered + static).
func (s *Server) peerSnapshot() []Peer {
	s.peersMu.RLock()
	defer s.peersMu.RUnlock()
	return append([]Peer{}, s.peers...)
}

func (s *Server) setPeers(peers []Peer) {
	s.peersMu.Lock()
	s.peers = peers
	s.peersMu.Unlock()
}

// peerForZone returns the peer owning qName's zone, if any. qName is a
// lower-case FQDN with a trailing dot ("plex.proj.").
func (s *Server) peerForZone(qName string) (Peer, bool) {
	for _, p := range s.peerSnapshot() {
		fqdn := p.Domain + "."
		if qName == fqdn || strings.HasSuffix(qName, "."+fqdn) {
			return p, true
		}
	}
	return Peer{}, false
}

func (s *Server) isPeerIP(ip net.IP) bool {
	if ip == nil {
		return false
	}
	for _, p := range s.peerSnapshot() {
		if peerIP := net.ParseIP(p.IP); peerIP != nil && peerIP.Equal(ip) {
			return true
		}
	}
	return false
}

// exchangePeer sends r to the peer's DNS port and returns its response.
func (s *Server) exchangePeer(r *dns.Msg, peer Peer, client *dns.Client) (*dns.Msg, error) {
	target := net.JoinHostPort(peer.IP, fmt.Sprintf("%d", s.store.DNSPort()))
	resp, _, err := client.Exchange(r, target)
	if err == nil && resp != nil && resp.Truncated {
		resp, _, err = s.dnsClientTC.Exchange(r, target)
	}
	return resp, err
}

// forwardToPeer relays the query to the zone's owner and writes its answer.
// Returns false when the peer can't be reached (caller falls back).
func (s *Server) forwardToPeer(w dns.ResponseWriter, r *dns.Msg, peer Peer) bool {
	resp, err := s.exchangePeer(r, peer, s.dnsClient)
	if err != nil || resp == nil {
		return false
	}
	_ = w.WriteMsg(resp)
	return true
}

// tryPeersForLocalMiss offers an unknown `.local` query to each peer in
// turn and returns the first non-NXDOMAIN answer, or nil.
func (s *Server) tryPeersForLocalMiss(r *dns.Msg) *dns.Msg {
	for _, peer := range s.peerSnapshot() {
		resp, err := s.exchangePeer(r, peer, s.peerClient)
		if err != nil || resp == nil {
			continue
		}
		if resp.Rcode != dns.RcodeNameError {
			return resp
		}
	}
	return nil
}

// discoverPeersLoop keeps the peer table fresh: static config plus a /24
// identity scan, refreshed every minute.
func (s *Server) discoverPeersLoop(ctx context.Context) {
	s.refreshPeers()
	ticker := time.NewTicker(peerDiscoveryInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.refreshPeers()
		}
	}
}

func (s *Server) refreshPeers() {
	ownDomain := s.store.Domain()
	merged := []Peer{}
	seen := map[string]bool{} // by IP

	add := func(p Peer) {
		if p.IP == "" || p.Domain == "" || p.Domain == ownDomain {
			return
		}
		if seen[p.IP] {
			return
		}
		seen[p.IP] = true
		merged = append(merged, p)
	}

	for _, p := range s.store.Peers() {
		add(Peer{IP: p.IP, Domain: p.Domain})
	}
	for _, p := range s.scanForPeers() {
		add(p)
	}
	s.setPeers(merged)
}

type identityResponse struct {
	InstanceID string `json:"instanceId"`
	Domain     string `json:"domain"`
}

// scanForPeers probes every host on the daemon's LAN /24 for
// GET /api/identity — the same discovery the companion app performs.
func (s *Server) scanForPeers() []Peer {
	lanIP := s.lanIP
	if lanIP == nil || !lanIP.IsPrivate() {
		return nil
	}
	prefix := lanIP.String()
	prefix = prefix[:strings.LastIndex(prefix, ".")+1]

	httpClient := &http.Client{Timeout: peerProbeTimeout}
	found := []Peer{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, 32)

	for host := 1; host <= 254; host++ {
		ip := fmt.Sprintf("%s%d", prefix, host)
		if ip == lanIP.String() {
			continue
		}
		wg.Add(1)
		go func(ip string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			url := fmt.Sprintf("http://%s/api/identity", ip)
			if port := s.store.HTTPPort(); port != 80 {
				url = fmt.Sprintf("http://%s:%d/api/identity", ip, port)
			}
			resp, err := httpClient.Get(url)
			if err != nil || resp.StatusCode != http.StatusOK {
				if resp != nil {
					resp.Body.Close()
				}
				return
			}
			body, err := io.ReadAll(io.LimitReader(resp.Body, 4096))
			resp.Body.Close()
			if err != nil {
				return
			}
			var ident identityResponse
			if json.Unmarshal(body, &ident) != nil {
				return
			}
			dom := strings.Trim(strings.ToLower(strings.TrimSpace(ident.Domain)), ".")
			id := strings.TrimSpace(ident.InstanceID)
			if dom == "" || id == "" || id == s.store.InstanceID() {
				return
			}
			if !strings.HasPrefix(id, "cs-") && !strings.HasPrefix(id, "ln-") {
				return
			}
			mu.Lock()
			found = append(found, Peer{IP: ip, Domain: dom, InstanceID: id})
			mu.Unlock()
		}(ip)
	}
	wg.Wait()
	return found
}
