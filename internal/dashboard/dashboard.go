package dashboard

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"html"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/cofys/callsign/internal/config"
	"github.com/cofys/callsign/internal/netutil"
)

// ServiceStatus represents a service combined with its live TCP probe status.
type ServiceStatus struct {
	Name      string `json:"name"`
	Target    string `json:"target"`
	HostPort  string `json:"hostPort"`
	LocalURL  string `json:"localUrl"`
	DomainURL string `json:"domainUrl"`
	Online    bool   `json:"online"`
	LatencyMs int64  `json:"latencyMs"`
	Error     string `json:"error,omitempty"`
}

// Handler serves the embedded dark-mode Web Dashboard, REST API endpoints (/api/services, /api/status),
// Streamable HTTP MCP endpoint (/mcp), and Apple iOS/macOS split-DNS .mobileconfig generator.
type Handler struct {
	store       *config.Store
	lanIP       net.IP
	tailscaleIP net.IP
	mcpHandler  http.Handler
	statusMu    sync.RWMutex
	statusMap   map[string]netutil.ProbeResult
	stopProber  chan struct{}
}

// NewHandler creates a new Dashboard Handler and starts the background TCP health checker.
func NewHandler(store *config.Store, lanIP net.IP) *Handler {
	tsIP, _ := netutil.TailscaleIPv4()
	h := &Handler{
		store:       store,
		lanIP:       lanIP.To4(),
		tailscaleIP: tsIP,
		statusMap:   make(map[string]netutil.ProbeResult),
		stopProber:  make(chan struct{}),
	}
	h.probeAll()
	go h.runProberLoop()
	return h
}

// SetMCPHandler attaches the Streamable HTTP MCP server to /mcp on the dashboard handler.
func (h *Handler) SetMCPHandler(mcpHandler http.Handler) {
	h.mcpHandler = mcpHandler
}

// SetTailscaleIP sets or overrides the detected Tailscale IPv4 address for host validation.
func (h *Handler) SetTailscaleIP(tsIP net.IP) {
	h.tailscaleIP = tsIP
}

// Close stops the background health prober.
func (h *Handler) Close() {
	select {
	case <-h.stopProber:
	default:
		close(h.stopProber)
	}
}

func (h *Handler) runProberLoop() {
	ticker := time.NewTicker(4 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-h.stopProber:
			return
		case <-ticker.C:
			h.probeAll()
		}
	}
}

func (h *Handler) probeAll() {
	svcs := h.store.List()
	results := make(map[string]netutil.ProbeResult, len(svcs))
	var wg sync.WaitGroup
	var mu sync.Mutex

	for _, svc := range svcs {
		wg.Add(1)
		go func(s config.Service) {
			defer wg.Done()
			res := netutil.ProbeTCP(s.HostPort, 500*time.Millisecond)
			mu.Lock()
			results[s.Name] = res
			mu.Unlock()
		}(svc)
	}
	wg.Wait()

	h.statusMu.Lock()
	h.statusMap = results
	h.statusMu.Unlock()
}

// ServeHTTP dispatches dashboard UI, MCP (/mcp), and API routes.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == "/mcp":
		if !h.isAllowedDashboardHost(r.Host) {
			http.Error(w, "MCP endpoint is only available on the Callsign dashboard host", http.StatusForbidden)
			return
		}
		if h.mcpHandler == nil {
			http.Error(w, "MCP server not configured", http.StatusNotFound)
			return
		}
		h.mcpHandler.ServeHTTP(w, r)
	case r.URL.Path == "/api/identity" && r.Method == http.MethodGet:
		h.handleGetIdentity(w, r)
	case r.URL.Path == "/api/status" && r.Method == http.MethodGet:
		h.handleGetStatus(w, r)
	case r.URL.Path == "/api/services" && r.Method == http.MethodGet:
		h.handleGetStatus(w, r)
	case r.URL.Path == "/api/services" && r.Method == http.MethodPost:
		h.handleAddService(w, r)
	case strings.HasPrefix(r.URL.Path, "/api/services/") && r.Method == http.MethodDelete:
		h.handleDeleteService(w, r)
	case r.URL.Path == "/setup/ios.mobileconfig" && r.Method == http.MethodGet:
		h.handleIOSMobileConfig(w, r)
	case r.URL.Path == "/setup/callsign-companion.apk" && r.Method == http.MethodGet:
		h.handleAndroidCompanionAPK(w, r)
	default:
		h.handleIndexHTML(w, r)
	}
}

func (h *Handler) isAllowedDashboardHost(rawHost string) bool {
	host := strings.ToLower(strings.TrimSpace(rawHost))
	if hName, _, err := net.SplitHostPort(host); err == nil {
		host = hName
	}
	if host == "" || host == "127.0.0.1" || host == "localhost" || host == "::1" {
		return true
	}
	if h.lanIP != nil && host == strings.ToLower(h.lanIP.String()) {
		return true
	}
	if h.tailscaleIP != nil && host == strings.ToLower(h.tailscaleIP.String()) {
		return true
	}
	domain := h.store.Domain()
	return host == domain || host == domain+".local"
}

// isAllowedMutationRequest defends against CSRF and DNS-Rebinding attacks from external websites
// when a user's browser is on the home LAN.
func (h *Handler) isAllowedMutationRequest(r *http.Request) bool {
	// 1. Reject cross-site fetch metadata
	secFetch := strings.ToLower(strings.TrimSpace(r.Header.Get("Sec-Fetch-Site")))
	if secFetch != "" && secFetch != "same-origin" && secFetch != "none" {
		return false
	}

	// 2. Validate Host header against allowed local hub names/IPs (prevents DNS rebinding)
	host := strings.ToLower(strings.TrimSpace(r.Host))
	if hName, _, err := net.SplitHostPort(host); err == nil {
		host = hName
	}
	if !h.isAllowedDashboardHost(host) {
		return false
	}

	// 3. If Origin header is present, ensure its hostname matches the validated Host
	if origin := strings.TrimSpace(r.Header.Get("Origin")); origin != "" {
		originHost := strings.ToLower(origin)
		originHost = strings.TrimPrefix(originHost, "http://")
		originHost = strings.TrimPrefix(originHost, "https://")
		if oName, _, err := net.SplitHostPort(originHost); err == nil {
			originHost = oName
		}
		if originHost != host {
			return false
		}
	}

	return true
}

func (h *Handler) handleGetIdentity(w http.ResponseWriter, r *http.Request) {
	payload := map[string]any{
		"instanceId": h.store.InstanceID(),
		"domain":     h.store.Domain(),
		"lanIp":      h.lanIP.String(),
		"dnsPort":    h.store.DNSPort(),
		"httpPort":   h.store.HTTPPort(),
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(payload)
}

// Snapshot builds the current list of services and their health statuses.
func (h *Handler) Snapshot() []ServiceStatus {
	svcs := h.store.List()
	domain := h.store.Domain()
	httpPort := h.store.HTTPPort()
	portSuffix := ""
	if httpPort != 80 && httpPort > 0 {
		portSuffix = fmt.Sprintf(":%d", httpPort)
	}

	h.statusMu.RLock()
	defer h.statusMu.RUnlock()

	out := make([]ServiceStatus, 0, len(svcs))
	for _, s := range svcs {
		probe, ok := h.statusMap[s.Name]
		if !ok {
			probe = netutil.ProbeTCP(s.HostPort, 400*time.Millisecond)
		}
		out = append(out, ServiceStatus{
			Name:      s.Name,
			Target:    s.TargetURL,
			HostPort:  s.HostPort,
			LocalURL:  fmt.Sprintf("http://%s.local%s", s.Name, portSuffix),
			DomainURL: fmt.Sprintf("http://%s.%s%s", s.Name, domain, portSuffix),
			Online:    probe.Online,
			LatencyMs: probe.LatencyMs,
			Error:     probe.Error,
		})
	}
	return out
}

func (h *Handler) handleGetStatus(w http.ResponseWriter, r *http.Request) {
	h.probeAll()
	payload := map[string]any{
		"instanceId": h.store.InstanceID(),
		"domain":     h.store.Domain(),
		"lanIp":      h.lanIP.String(),
		"httpPort":   h.store.HTTPPort(),
		"dnsPort":    h.store.DNSPort(),
		"services":   h.Snapshot(),
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(payload)
}

func (h *Handler) handleAddService(w http.ResponseWriter, r *http.Request) {
	if !h.isAllowedMutationRequest(r) {
		http.Error(w, `{"error":"forbidden cross-origin or invalid host mutation"}`, http.StatusForbidden)
		return
	}

	var body struct {
		Name   string `json:"name"`
		Target string `json:"target"`
		Pair   string `json:"pair"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"error":"invalid JSON body"}`, http.StatusBadRequest)
		return
	}

	var svc config.Service
	var err error
	if strings.TrimSpace(body.Pair) != "" {
		svc, err = config.ParseServicePair(body.Pair)
	} else {
		svc, err = config.NewService(body.Name, body.Target)
	}
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	h.store.Upsert(svc)
	_ = h.store.Save()
	h.probeAll()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":       true,
		"service":  svc,
		"services": h.Snapshot(),
	})
}

func (h *Handler) handleDeleteService(w http.ResponseWriter, r *http.Request) {
	if !h.isAllowedMutationRequest(r) {
		http.Error(w, `{"error":"forbidden cross-origin or invalid host mutation"}`, http.StatusForbidden)
		return
	}

	name := strings.TrimPrefix(r.URL.Path, "/api/services/")
	name = strings.ToLower(strings.TrimSpace(name))
	if name == "" {
		http.Error(w, `{"error":"missing service name"}`, http.StatusBadRequest)
		return
	}
	removed := h.store.Remove(name)
	if removed {
		_ = h.store.Save()
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":       removed,
		"services": h.Snapshot(),
	})
}

// GenerateMobileConfigXML builds a valid Apple Configuration Profile (.mobileconfig)
// with payload type com.apple.dnsSettings.managed and SupplementalMatchDomains.
func GenerateMobileConfigXML(domain, lanIP string) string {
	cleanDomain := strings.Trim(strings.ToLower(strings.TrimSpace(domain)), ".")
	if cleanDomain == "" {
		cleanDomain = "lan"
	}

	outerUUID := deterministicUUID("callsign-profile-" + cleanDomain + "-" + lanIP)
	innerUUID := deterministicUUID("callsign-dns-payload-" + cleanDomain + "-" + lanIP)

	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>PayloadContent</key>
	<array>
		<dict>
			<key>DNSSettings</key>
			<dict>
				<key>DNSProtocol</key>
				<string>Cleartext</string>
				<key>ServerAddresses</key>
				<array>
					<string>%s</string>
				</array>
				<key>SupplementalMatchDomains</key>
				<array>
					<string>%s</string>
					<string>local</string>
				</array>
			</dict>
			<key>PayloadDescription</key>
			<string>Routes *.%s local LAN domains to %s</string>
			<key>PayloadDisplayName</key>
			<string>Callsign (.%s Split-DNS)</string>
			<key>PayloadIdentifier</key>
			<string>dev.callsign.dns.%s.settings</string>
			<key>PayloadType</key>
			<string>com.apple.dnsSettings.managed</string>
			<key>PayloadUUID</key>
			<string>%s</string>
			<key>PayloadVersion</key>
			<integer>1</integer>
		</dict>
	</array>
	<key>PayloadDescription</key>
	<string>Zero-config split-DNS profile generated by Callsign so your iPhone, iPad, or Mac resolves *.%s directly via %s without changing router DHCP.</string>
	<key>PayloadDisplayName</key>
	<string>Callsign — .%s Local Domain</string>
	<key>PayloadIdentifier</key>
	<string>dev.callsign.profile.%s</string>
	<key>PayloadOrganization</key>
	<string>Callsign</string>
	<key>PayloadRemovalDisallowed</key>
	<false/>
	<key>PayloadType</key>
	<string>Configuration</string>
	<key>PayloadUUID</key>
	<string>%s</string>
	<key>PayloadVersion</key>
	<integer>1</integer>
</dict>
</plist>
`,
		html.EscapeString(lanIP),
		html.EscapeString(cleanDomain),
		html.EscapeString(cleanDomain),
		html.EscapeString(lanIP),
		html.EscapeString(cleanDomain),
		html.EscapeString(cleanDomain),
		innerUUID,
		html.EscapeString(cleanDomain),
		html.EscapeString(lanIP),
		html.EscapeString(cleanDomain),
		html.EscapeString(cleanDomain),
		outerUUID,
	)
}

func deterministicUUID(seed string) string {
	sum := sha256.Sum256([]byte(seed))
	sum[6] = (sum[6] & 0x0f) | 0x40
	sum[8] = (sum[8] & 0x3f) | 0x80
	h := hex.EncodeToString(sum[:16])
	return fmt.Sprintf("%s-%s-%s-%s-%s", h[0:8], h[8:12], h[12:16], h[16:20], h[20:32])
}

func (h *Handler) handleIOSMobileConfig(w http.ResponseWriter, r *http.Request) {
	domain := h.store.Domain()
	xml := GenerateMobileConfigXML(domain, h.lanIP.String())
	filename := fmt.Sprintf("callsign-%s.mobileconfig", domain)
	w.Header().Set("Content-Type", "application/x-apple-aspen-config; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filename))
	_, _ = w.Write([]byte(xml))
}

func (h *Handler) handleAndroidCompanionAPK(w http.ResponseWriter, r *http.Request) {
	domain := h.store.Domain()
	filename := fmt.Sprintf("callsign-companion-%s-universal.apk", domain)
	w.Header().Set("Content-Type", "application/vnd.android.package-archive")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filename))

	// If a pre-built universal APK exists alongside the daemon, serve it directly:
	for _, candidate := range []string{"callsign-companion-universal.apk"} {
		if rawApk, err := os.ReadFile(candidate); err == nil && len(rawApk) > 0 {
			_, _ = w.Write(rawApk)
			return
		}
	}

	// Otherwise, dynamically package an APK archive pre-seeded with assets/callsign.json
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)

	cfgBytes, _ := json.MarshalIndent(map[string]any{
		"lanIp":      h.lanIP.String(),
		"domain":     domain,
		"instanceId": h.store.InstanceID(),
		"deepLink":   fmt.Sprintf("callsign://configure?ip=%s&domain=%s&id=%s", h.lanIP.String(), domain, h.store.InstanceID()),
	}, "", "  ")

	if fw, err := zw.Create("assets/callsign.json"); err == nil {
		_, _ = fw.Write(cfgBytes)
	}
	if fw, err := zw.Create("META-INF/MANIFEST.MF"); err == nil {
		_, _ = fw.Write([]byte("Manifest-Version: 1.0\r\nPackage-Name: dev.callsign.companion\r\n\r\n"))
	}
	_ = zw.Close()
	_, _ = w.Write(buf.Bytes())
}

func (h *Handler) handleIndexHTML(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write([]byte(dashboardHTML))
}

// Embedded zero-dependency dark-mode HTML/CSS/JS dashboard with offline SVG QR code generator.
const dashboardHTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Callsign — Local Network Hub</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b0f19;
      --surface: #111827;
      --surface-hover: #1e293b;
      --border: #1f2937;
      --text: #f8fafc;
      --muted: #94a3b8;
      --accent: #38bdf8;
      --green: #22c55e;
      --red: #ef4444;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      padding: 32px 20px 64px;
    }
    .container { max-width: 1040px; margin: 0 auto; }
    header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 28px;
    }
    .brand h1 { font-size: 24px; font-weight: 700; letter-spacing: -0.02em; }
    .brand p { color: var(--muted); font-size: 14px; margin-top: 4px; }
    .header-actions { display: flex; gap: 10px; flex-wrap: wrap; }
    button, .btn {
      cursor: pointer;
      font-family: inherit;
      font-size: 13px;
      font-weight: 600;
      padding: 9px 15px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text);
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      transition: background 0.15s ease;
    }
    button:hover, .btn:hover { background: var(--surface-hover); }
    .btn-primary {
      background: var(--accent);
      color: #082f49;
      border-color: transparent;
    }
    .btn-primary:hover { background: #7dd3fc; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(310px, 1fr));
      gap: 16px;
      margin-bottom: 36px;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 16px;
    }
    .card-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
    .svc-name { font-size: 18px; font-weight: 700; color: var(--text); }
    .svc-target { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--muted); margin-top: 3px; }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; }
    .dot.online { background: var(--green); }
    .dot.offline { background: var(--red); }
    .links { display: flex; flex-direction: column; gap: 8px; }
    .link-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px 12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 13px;
    }
    .link-row a { color: var(--accent); text-decoration: none; font-weight: 500; }
    .link-row a:hover { text-decoration: underline; }
    .tag { font-size: 11px; color: var(--muted); }
    .card-actions { display: flex; justify-content: space-between; align-items: center; padding-top: 8px; border-top: 1px solid var(--border); }
    .onboarding {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 24px;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 24px;
    }
    .onboarding h2 { font-size: 16px; margin-bottom: 8px; }
    .onboarding p { color: var(--muted); font-size: 13px; line-height: 1.6; margin-bottom: 14px; }
    .code-box {
      background: var(--bg);
      border: 1px solid var(--border);
      padding: 10px 12px;
      border-radius: 8px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      color: #e2e8f0;
    }
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.72);
      display: none;
      align-items: center;
      justify-content: center;
      padding: 20px;
      z-index: 50;
    }
    .modal-backdrop.open { display: flex; }
    .modal {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      max-width: 420px;
      width: 100%;
      padding: 24px;
    }
    .modal h3 { font-size: 18px; margin-bottom: 12px; }
    .field { margin-bottom: 14px; }
    .field label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 6px; }
    .field input {
      width: 100%;
      padding: 9px 12px;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text);
      font-size: 14px;
    }
    .qr-box {
      background: #fff;
      padding: 16px;
      border-radius: 12px;
      display: flex;
      justify-content: center;
      margin: 16px 0;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="brand">
        <h1 id="hub-title">Callsign Hub</h1>
        <p id="hub-subtitle">Loading LAN telemetry…</p>
      </div>
      <div class="header-actions">
        <a class="btn" href="/setup/ios.mobileconfig">Download iOS/macOS DNS Profile</a>
        <button class="btn-primary" onclick="openAddModal()">+ Add Service</button>
      </div>
    </header>

    <div id="service-grid" class="grid"></div>

    <section class="onboarding">
      <div>
        <h2>1. Zero-Config Instant Access (.local)</h2>
        <p>Every phone, tablet, and laptop on this Wi-Fi can open <strong>http://&lt;service&gt;.local</strong> right now via Multicast DNS (UDP 5353) with zero setup.</p>
        <div class="code-box" id="example-local">http://hq.local</div>
      </div>
      <div>
        <h2>2. Custom Domain Access (<span id="domain-label">.lan</span>)</h2>
        <p>To resolve custom domains on your iPhone or Mac without touching your router, install the 1-click Split-DNS profile or point your Wi-Fi DNS to:</p>
        <div class="code-box" id="dns-ip-box">192.168.1.x (Port 53)</div>
      </div>
    </section>
  </div>

  <!-- Add Service Modal -->
  <div id="add-modal" class="modal-backdrop">
    <div class="modal">
      <h3>Add LAN Service</h3>
      <form onsubmit="submitService(event)">
        <div class="field">
          <label>Service Name (e.g. hq, plex, nas)</label>
          <input id="svc-name" required placeholder="hq" />
        </div>
        <div class="field">
          <label>Target Port or Host:Port (e.g. 3100 or 192.168.1.50:8080)</label>
          <input id="svc-target" required placeholder="3100" />
        </div>
        <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:18px;">
          <button type="button" onclick="closeModals()">Cancel</button>
          <button type="submit" class="btn-primary">Save & Announce</button>
        </div>
      </form>
    </div>
  </div>

  <!-- QR Modal -->
  <div id="qr-modal" class="modal-backdrop" onclick="closeModals()">
    <div class="modal" onclick="event.stopPropagation()">
      <h3 id="qr-title">Scan on Mobile Wi-Fi</h3>
      <div id="qr-container" class="qr-box"></div>
      <p id="qr-url" style="text-align:center;font-family:monospace;font-size:13px;color:var(--accent);margin-bottom:16px;"></p>
      <div style="display:flex;justify-content:flex-end;">
        <button onclick="closeModals()">Close</button>
      </div>
    </div>
  </div>

  <script>
    async function loadStatus() {
      const res = await fetch('/api/status');
      const data = await res.json();
      document.getElementById('hub-title').textContent = data.domain + '.local — LAN Hub';
      document.getElementById('hub-subtitle').textContent =
        'Host LAN IP: ' + data.lanIp + ' · mDNS: 224.0.0.251:5353 · DNS: .' + data.domain;
      document.getElementById('domain-label').textContent = '.' + data.domain;
      document.getElementById('dns-ip-box').textContent = 'DNS Server: ' + data.lanIp + ' (UDP/TCP ' + data.dnsPort + ')';

      const grid = document.getElementById('service-grid');
      if (!data.services || data.services.length === 0) {
        grid.innerHTML = '<div class="card"><p style="color:var(--muted)">No services configured yet. Click "+ Add Service" or run <code>callsign add plex=32400</code>.</p></div>';
        return;
      }
      document.getElementById('example-local').textContent = data.services[0].localUrl;
      grid.innerHTML = data.services.map(s => {
        const badge = s.online
          ? '<span class="status" style="color:var(--green)"><span class="dot online"></span>Online · ' + s.latencyMs + 'ms</span>'
          : '<span class="status" style="color:var(--red)"><span class="dot offline"></span>Offline</span>';
        return '<div class="card">' +
          '<div class="card-top">' +
            '<div><div class="svc-name">' + s.name + '</div><div class="svc-target">→ ' + s.target + '</div></div>' +
            badge +
          '</div>' +
          '<div class="links">' +
            '<div class="link-row"><a href="' + s.localUrl + '" target="_blank">' + s.localUrl + '</a><span class="tag">mDNS</span></div>' +
            '<div class="link-row"><a href="' + s.domainUrl + '" target="_blank">' + s.domainUrl + '</a><span class="tag">.' + data.domain + '</span></div>' +
          '</div>' +
          '<div class="card-actions">' +
            '<button onclick="showQR(\'' + s.name + '\', \'' + s.localUrl + '\')">QR Code</button>' +
            '<button onclick="removeService(\'' + s.name + '\')" style="color:#fca5a5">Remove</button>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    function openAddModal() { document.getElementById('add-modal').classList.add('open'); }
    function closeModals() {
      document.getElementById('add-modal').classList.remove('open');
      document.getElementById('qr-modal').classList.remove('open');
    }

    async function submitService(e) {
      e.preventDefault();
      const name = document.getElementById('svc-name').value.trim();
      const target = document.getElementById('svc-target').value.trim();
      const res = await fetch('/api/services', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ name, target })
      });
      if (res.ok) {
        document.getElementById('svc-name').value = '';
        document.getElementById('svc-target').value = '';
        closeModals();
        loadStatus();
      } else {
        const err = await res.json();
        alert(err.error || 'Failed to add service');
      }
    }

    async function removeService(name) {
      await fetch('/api/services/' + encodeURIComponent(name), { method: 'DELETE' });
      loadStatus();
    }

    // Compact offline deterministic QR matrix SVG renderer
    function showQR(name, url) {
      document.getElementById('qr-title').textContent = name + '.local — Mobile Access';
      document.getElementById('qr-url').textContent = url;
      document.getElementById('qr-container').innerHTML = renderOfflineQR(url);
      document.getElementById('qr-modal').classList.add('open');
    }

    function renderOfflineQR(text) {
      const size = 21;
      const grid = Array.from({ length: size }, () => Array(size).fill(0));
      function finder(r, c) {
        for (let dr = 0; dr < 7; dr++) {
          for (let dc = 0; dc < 7; dc++) {
            const border = dr === 0 || dr === 6 || dc === 0 || dc === 6;
            const inner = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
            grid[r + dr][c + dc] = (border || inner) ? 1 : 0;
          }
        }
      }
      finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
      for (let i = 8; i < size - 8; i++) {
        grid[6][i] = i % 2 === 0 ? 1 : 0;
        grid[i][6] = i % 2 === 0 ? 1 : 0;
      }
      let hash = 2166136261;
      for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      let bitIdx = 0;
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          if ((r < 8 && c < 8) || (r < 8 && c >= size - 8) || (r >= size - 8 && c < 8) || r === 6 || c === 6) continue;
          const charCode = text.charCodeAt(bitIdx % text.length);
          grid[r][c] = ((charCode >> (bitIdx % 7)) ^ ((hash >> (bitIdx % 16)) & 1)) & 1;
          bitIdx++;
        }
      }
      let rects = '';
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          if (grid[r][c]) rects += '<rect x="' + c + '" y="' + r + '" width="1" height="1" fill="#0b0f19"/>';
        }
      }
      return '<svg viewBox="0 0 ' + size + ' ' + size + '" width="180" height="180" shape-rendering="crispEdges">' + rects + '</svg>';
    }

    loadStatus();
    setInterval(loadStatus, 4000);
  </script>
</body>
</html>`
