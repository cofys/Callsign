package proxy

import (
	"fmt"
	"html"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"github.com/lanname/lanname/internal/config"
)

// Router dispatches incoming HTTP/WebSocket requests on port 80 either to the matching
// upstream service (when Host matches <service>.local or <service>.<domain>) or to the
// embedded Web Dashboard when Host matches the base hub (<domain>.local, <domain>, <LAN_IP>, localhost).
type Router struct {
	store     *config.Store
	lanIP     net.IP
	dashboard http.Handler
	transport *http.Transport
}

// NewRouter creates a new reverse-proxy and dashboard HTTP router.
func NewRouter(store *config.Store, lanIP net.IP, dashboard http.Handler) *Router {
	return &Router{
		store:     store,
		lanIP:     lanIP,
		dashboard: dashboard,
		transport: &http.Transport{
			Proxy: http.ProxyFromEnvironment,
			DialContext: (&net.Dialer{
				Timeout:   4 * time.Second,
				KeepAlive: 30 * time.Second,
			}).DialContext,
			ForceAttemptHTTP2:     false, // Keep HTTP/1.1 cleanly compatible with raw WebSocket upgrades
			MaxIdleConns:          100,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   5 * time.Second,
			ExpectContinueTimeout: 1 * time.Second,
		},
	}
}

// ServeHTTP routes incoming HTTP and WebSocket requests based on the Host header.
func (rt *Router) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	host := stripPort(r.Host)
	domain := rt.store.Domain()

	// Always allow direct access to the health check ping endpoint for 502 auto-retry polling
	if r.URL.Path == "/__lanname_ping" {
		rt.handleUpstreamPing(w, r, host, domain)
		return
	}

	// Base hub hostnames route to the Web Dashboard
	if rt.isHubHost(host, domain) {
		rt.dashboard.ServeHTTP(w, r)
		return
	}

	svcName := extractServiceName(host, domain)
	if svcName == "" {
		rt.dashboard.ServeHTTP(w, r)
		return
	}

	svc, ok := rt.store.Get(svcName)
	if !ok {
		rt.renderUnknownServicePage(w, r, svcName, host, domain)
		return
	}

	targetURL, err := url.Parse(svc.TargetURL)
	if err != nil {
		http.Error(w, fmt.Sprintf("invalid target URL for %s: %v", svc.Name, err), http.StatusInternalServerError)
		return
	}

	proxy := &httputil.ReverseProxy{
		Director: func(req *http.Request) {
			originalHost := req.Host
			req.URL.Scheme = targetURL.Scheme
			req.URL.Host = targetURL.Host
			req.Host = originalHost

			clientIP := extractClientIP(req.RemoteAddr)
			if prior := req.Header.Get("X-Forwarded-For"); prior != "" {
				req.Header.Set("X-Forwarded-For", prior+", "+clientIP)
			} else {
				req.Header.Set("X-Forwarded-For", clientIP)
			}
			req.Header.Set("X-Real-IP", clientIP)
			req.Header.Set("X-Forwarded-Host", originalHost)
			if req.TLS != nil {
				req.Header.Set("X-Forwarded-Proto", "https")
			} else {
				req.Header.Set("X-Forwarded-Proto", "http")
			}
		},
		Transport:     rt.transport,
		FlushInterval: -1, // Flush immediately for SSE and streaming responses
		ErrorHandler: func(rw http.ResponseWriter, req *http.Request, proxyErr error) {
			rt.renderFriendly502(rw, req, svc, domain, proxyErr)
		},
	}

	proxy.ServeHTTP(w, r)
}

func (rt *Router) handleUpstreamPing(w http.ResponseWriter, r *http.Request, host, domain string) {
	svcName := r.URL.Query().Get("service")
	if svcName == "" {
		svcName = extractServiceName(host, domain)
	}
	svc, ok := rt.store.Get(svcName)
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"online":false}`))
		return
	}
	conn, err := net.DialTimeout("tcp", svc.HostPort, 500*time.Millisecond)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`{"online":false}`))
		return
	}
	_ = conn.Close()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"online":true}`))
}

func (rt *Router) isHubHost(host, domain string) bool {
	if host == "" || host == "localhost" || host == "127.0.0.1" {
		return true
	}
	if rt.lanIP != nil && host == rt.lanIP.String() {
		return true
	}
	if host == domain || host == domain+".local" {
		return true
	}
	return false
}

func extractServiceName(host, domain string) string {
	h := strings.ToLower(strings.TrimSpace(host))
	h = strings.TrimSuffix(h, ".")

	if strings.HasSuffix(h, ".local") {
		sub := strings.TrimSuffix(h, ".local")
		if sub != "" && sub != domain {
			return sub
		}
		return ""
	}

	domainSuffix := "." + strings.ToLower(domain)
	if strings.HasSuffix(h, domainSuffix) {
		sub := strings.TrimSuffix(h, domainSuffix)
		if sub != "" {
			return sub
		}
		return ""
	}

	return h
}

func stripPort(hostport string) string {
	h := strings.TrimSpace(hostport)
	if host, _, err := net.SplitHostPort(h); err == nil {
		return strings.ToLower(host)
	}
	return strings.ToLower(h)
}

func extractClientIP(remoteAddr string) string {
	if host, _, err := net.SplitHostPort(remoteAddr); err == nil {
		return host
	}
	return remoteAddr
}

func (rt *Router) renderFriendly502(
	w http.ResponseWriter,
	r *http.Request,
	svc config.Service,
	domain string,
	proxyErr error,
) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusBadGateway)

	reason := "Connection Refused — is the upstream service running?"
	if proxyErr != nil {
		msg := proxyErr.Error()
		if strings.Contains(msg, "timeout") {
			reason = "Upstream Connection Timed Out — verify host and firewall rules."
		} else if !strings.Contains(msg, "connection refused") {
			reason = msg
		}
	}

	hubURL := fmt.Sprintf("http://%s.local/", html.EscapeString(domain))
	page := fmt.Sprintf(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>%s is Offline — lanname</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0b0f19;
      color: #f8fafc;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      max-width: 540px;
      width: 100%%;
      background: #111827;
      border: 1px solid #1f2937;
      border-radius: 14px;
      padding: 32px;
      box-shadow: 0 20px 40px rgba(0,0,0,0.45);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      font-weight: 600;
      color: #fca5a5;
      background: rgba(239, 68, 68, 0.12);
      border: 1px solid rgba(239, 68, 68, 0.25);
      padding: 4px 10px;
      border-radius: 999px;
      margin-bottom: 16px;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%%;
      background: #ef4444;
    }
    h1 { font-size: 22px; font-weight: 700; margin-bottom: 8px; }
    p { color: #94a3b8; font-size: 14px; line-height: 1.6; margin-bottom: 20px; }
    .meta {
      background: #0b0f19;
      border: 1px solid #1e293b;
      border-radius: 10px;
      padding: 14px 16px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 13px;
      margin-bottom: 20px;
    }
    .meta div { display: flex; justify-content: space-between; padding: 4px 0; }
    .meta span.label { color: #64748b; }
    .meta span.val { color: #e2e8f0; }
    .actions { display: flex; gap: 12px; align-items: center; justify-content: space-between; }
    a.btn {
      display: inline-block;
      text-decoration: none;
      background: #1e293b;
      color: #f8fafc;
      padding: 9px 16px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 500;
      border: 1px solid #334155;
    }
    a.btn:hover { background: #334155; }
    .poll-status { font-size: 12px; color: #64748b; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge"><span class="dot"></span> 502 Bad Gateway · Upstream Offline</div>
    <h1>Service "%s" is not responding</h1>
    <p>%s</p>
    <div class="meta">
      <div><span class="label">Requested Host</span><span class="val">%s</span></div>
      <div><span class="label">Upstream Target</span><span class="val">%s</span></div>
      <div><span class="label">Service Name</span><span class="val">%s</span></div>
    </div>
    <div class="actions">
      <a class="btn" href="%s">← Back to %s.local Hub</a>
      <span class="poll-status" id="poll">Auto-checking every 2s…</span>
    </div>
  </div>
  <script>
    const svc = %q;
    async function check() {
      try {
        const res = await fetch('/__lanname_ping?service=' + encodeURIComponent(svc), { cache: 'no-store' });
        if (res.ok) {
          document.getElementById('poll').textContent = 'Upstream online! Reloading…';
          window.location.reload();
        }
      } catch (_) {}
    }
    setInterval(check, 2000);
  </script>
</body>
</html>`,
		html.EscapeString(svc.Name),
		html.EscapeString(svc.Name),
		html.EscapeString(reason),
		html.EscapeString(r.Host),
		html.EscapeString(svc.TargetURL),
		html.EscapeString(svc.Name),
		hubURL,
		html.EscapeString(domain),
		svc.Name,
	)

	_, _ = w.Write([]byte(page))
}

func (rt *Router) renderUnknownServicePage(w http.ResponseWriter, r *http.Request, svcName, host, domain string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusNotFound)
	hubURL := fmt.Sprintf("http://%s.local/", html.EscapeString(domain))
	page := fmt.Sprintf(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Unknown Service %s — lanname</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0b0f19; color: #f8fafc; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; margin: 0; }
    .card { max-width: 500px; width: 100%%; background: #111827; border: 1px solid #1f2937; border-radius: 14px; padding: 28px; }
    h1 { font-size: 20px; margin: 0 0 8px; }
    p { color: #94a3b8; font-size: 14px; line-height: 1.6; }
    code { background: #0b0f19; padding: 3px 6px; border-radius: 5px; color: #38bdf8; }
    a { display: inline-block; margin-top: 16px; color: #38bdf8; text-decoration: none; font-size: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>No service mapped for "%s"</h1>
    <p>Host <code>%s</code> reached this machine, but no service named <code>%s</code> is registered.</p>
    <p>Run <code>lanname add %s=3000</code> or add it from the web hub.</p>
    <a href="%s">Open %s.local Dashboard →</a>
  </div>
</body>
</html>`,
		html.EscapeString(svcName),
		html.EscapeString(svcName),
		html.EscapeString(host),
		html.EscapeString(svcName),
		html.EscapeString(svcName),
		hubURL,
		html.EscapeString(domain),
	)
	_, _ = w.Write([]byte(page))
}
