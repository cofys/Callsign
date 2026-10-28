package main

import (
	"bytes"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cofys/callsign/internal/config"
	"github.com/cofys/callsign/internal/dashboard"
	"github.com/cofys/callsign/internal/mcp"
	"github.com/cofys/callsign/internal/proxy"
)

func TestMCPHTTPTransportAndHostIsolation(t *testing.T) {
	tmpDir := t.TempDir()
	cfgPath := filepath.Join(tmpDir, "callsign.yaml")
	store := config.NewStore(cfgPath)
	store.SetRuntimeFlags("x", 8080, 5354, true, true)

	// Start a mock backend service for "plex"
	backendHit := false
	backendSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		backendHit = true
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("plex-upstream-ok"))
	}))
	defer backendSrv.Close()

	svc, err := config.NewService("plex", backendSrv.Listener.Addr().String())
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	store.Upsert(svc)

	lanIP := net.ParseIP("192.168.1.159")
	tsIP := net.ParseIP("100.85.12.34")

	// 1. Construct MCP server WITHOUT mutations or token first
	mcpReadOnly := mcp.NewServer(store, lanIP, tsIP, false, "")
	dash := dashboard.NewHandler(store, lanIP)
	defer dash.Close()
	dash.SetTailscaleIP(tsIP)
	dash.SetMCPHandler(mcpReadOnly)

	router := proxy.NewRouter(store, lanIP, dash)
	router.SetTailscaleIP(tsIP)

	// Verify tools/list works on dashboard hosts (x.local, x, 127.0.0.1, LAN IP, Tailscale IP)
	for _, host := range []string{"x.local", "x", "127.0.0.1", "192.168.1.159", "100.85.12.34"} {
		body := `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`
		req := httptest.NewRequest(http.MethodPost, "http://"+host+"/mcp", strings.NewReader(body))
		req.Host = host
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("tools/list on host %s failed with status %d: %s", host, rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), "callsign_register_service") ||
			!strings.Contains(rec.Body.String(), "callsign_remove_service") {
			t.Fatalf("expected both callsign_register_service and callsign_remove_service in tools/list for %s, got: %s", host, rec.Body.String())
		}
	}

	// Verify /mcp on a proxied service host (plex.x) goes to the proxied upstream, NOT the MCP server
	backendHit = false
	reqProxied := httptest.NewRequest(http.MethodPost, "http://plex.x/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
	reqProxied.Host = "plex.x"
	recProxied := httptest.NewRecorder()
	router.ServeHTTP(recProxied, reqProxied)
	if !backendHit || recProxied.Body.String() != "plex-upstream-ok" {
		t.Fatalf("expected request to plex.x/mcp to route to proxied service, got status=%d body=%q", recProxied.Code, recProxied.Body.String())
	}

	// 2. Verify callsign_register_service over HTTP is REFUSED when mutation flag & token are not set
	regPayload := `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"callsign_register_service","arguments":{"name":"ollama","target":"11434"}}}`
	reqRefused := httptest.NewRequest(http.MethodPost, "http://x.local/mcp", strings.NewReader(regPayload))
	reqRefused.Host = "x.local"
	recRefused := httptest.NewRecorder()
	router.ServeHTTP(recRefused, reqRefused)
	if !strings.Contains(recRefused.Body.String(), `"isError":true`) {
		t.Fatalf("expected mutation without flag/token to be refused, got: %s", recRefused.Body.String())
	}

	// 3. Verify callsign_register_service over HTTP is ALSO REFUSED when --allow-agent-mutations is true but NO token is configured
	mcpNoToken := mcp.NewServer(store, lanIP, tsIP, true, "")
	dash.SetMCPHandler(mcpNoToken)
	reqNoTok := httptest.NewRequest(http.MethodPost, "http://x.local/mcp", strings.NewReader(regPayload))
	reqNoTok.Host = "x.local"
	recNoTok := httptest.NewRecorder()
	router.ServeHTTP(recNoTok, reqNoTok)
	if !strings.Contains(recNoTok.Body.String(), `"isError":true`) {
		t.Fatalf("expected HTTP mutation without configured agent token to be refused, got: %s", recNoTok.Body.String())
	}

	// 4. Verify callsign_register_service and callsign_remove_service SUCCEED when both flag and token are set and matching Bearer header is sent
	mcpAuthed := mcp.NewServer(store, lanIP, tsIP, true, "cs_tok_test_secret")
	dash.SetMCPHandler(mcpAuthed)

	// Without Bearer header -> refused
	reqMissingHeader := httptest.NewRequest(http.MethodPost, "http://x.local/mcp", strings.NewReader(regPayload))
	reqMissingHeader.Host = "x.local"
	recMissingHeader := httptest.NewRecorder()
	router.ServeHTTP(recMissingHeader, reqMissingHeader)
	if !strings.Contains(recMissingHeader.Body.String(), `"isError":true`) {
		t.Fatalf("expected HTTP mutation without Authorization header to be refused, got: %s", recMissingHeader.Body.String())
	}

	// With valid Bearer header -> succeeds
	reqValidReg := httptest.NewRequest(http.MethodPost, "http://100.85.12.34/mcp", strings.NewReader(regPayload))
	reqValidReg.Host = "100.85.12.34"
	reqValidReg.Header.Set("Authorization", "Bearer cs_tok_test_secret")
	recValidReg := httptest.NewRecorder()
	router.ServeHTTP(recValidReg, reqValidReg)
	if !strings.Contains(recValidReg.Body.String(), `"isError":false`) || !strings.Contains(recValidReg.Body.String(), `registered`) {
		t.Fatalf("expected HTTP register with valid flag+token to succeed, got: %s", recValidReg.Body.String())
	}
	if _, ok := store.Get("ollama"); !ok {
		t.Fatalf("expected ollama service to be registered in store")
	}

	// Now remove service with valid Bearer header -> succeeds
	rmPayload := `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"callsign_remove_service","arguments":{"name":"ollama"}}}`
	reqValidRm := httptest.NewRequest(http.MethodPost, "http://x.local/mcp", bytes.NewBufferString(rmPayload))
	reqValidRm.Host = "x.local"
	reqValidRm.Header.Set("Authorization", "Bearer cs_tok_test_secret")
	recValidRm := httptest.NewRecorder()
	router.ServeHTTP(recValidRm, reqValidRm)
	if !strings.Contains(recValidRm.Body.String(), `"isError":false`) || !strings.Contains(recValidRm.Body.String(), `removed`) {
		t.Fatalf("expected HTTP remove with valid flag+token to succeed, got: %s", recValidRm.Body.String())
	}
	if _, ok := store.Get("ollama"); ok {
		t.Fatalf("expected ollama service to be removed from store")
	}
}

func TestCallsignConfigAndPing(t *testing.T) {
	tmpDir := t.TempDir()
	configPath := filepath.Join(tmpDir, "callsign.yaml")

	configYAML := `instance_id: cs-test123456
domain: home
http_port: 8080
dns_port: 5354
services:
  plex: http://127.0.0.1:32400
  ha: http://127.0.0.1:8123
`
	if err := os.WriteFile(configPath, []byte(configYAML), 0o644); err != nil {
		t.Fatalf("write callsign.yaml: %v", err)
	}

	store := config.NewStore(configPath)
	if err := store.Load(); err != nil {
		t.Fatalf("Load() failed on callsign.yaml: %v", err)
	}

	if store.Domain() != "home" {
		t.Fatalf("expected domain 'home', got %q", store.Domain())
	}
	if store.InstanceID() != "cs-test123456" {
		t.Fatalf("expected instance_id 'cs-test123456', got %q", store.InstanceID())
	}
	if _, ok := store.Get("plex"); !ok {
		t.Fatalf("expected service 'plex' to exist")
	}

	// Verify /__callsign_ping works on proxy.Router
	lanIP := net.ParseIP("192.168.1.159")
	dash := dashboard.NewHandler(store, lanIP)
	defer dash.Close()
	router := proxy.NewRouter(store, lanIP, dash)

	req := httptest.NewRequest(http.MethodGet, "http://plex.home/__callsign_ping?service=plex", nil)
	req.Host = "plex.home"
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	var resp map[string]bool
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("endpoint /__callsign_ping returned non-JSON %q: %v", rec.Body.String(), err)
	}

	// Verify Apple mobileconfig uses dev.callsign.* identifiers
	xml := dashboard.GenerateMobileConfigXML("x", "192.168.1.159")
	if !strings.Contains(xml, "dev.callsign.dns.x.settings") || !strings.Contains(xml, "dev.callsign.profile.x") {
		t.Fatalf("expected mobileconfig XML to use dev.callsign.* identifiers, got: %s", xml)
	}
	if strings.Contains(strings.ToLower(xml), "lanname") {
		t.Fatalf("expected mobileconfig XML to have zero occurrences of lanname, got: %s", xml)
	}
}
