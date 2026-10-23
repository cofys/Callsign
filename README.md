# `lanname` — Zero-Config LAN Naming & Reverse Proxy Daemon

`lanname` is a single-binary Go daemon for homelabs and home networks that replaces fragile `http://192.168.1.50:3100` port bookmarks with clean, memorable URLs (`http://hq.local` and `http://hq.cofy`) across every laptop, phone, and tablet on your Wi-Fi.

```bash
lanname serve hq=3100 pool=3001 nas=192.168.1.50:8080 --domain cofy
```

---

## Architecture Overview

When you run `lanname serve`, a single Go process coordinates four networking subsystems simultaneously:

1. **Multi-Host mDNS Responder (`UDP 224.0.0.251:5353` — `internal/mdns`):**
   - Uses `net.ListenConfig` with `SO_REUSEADDR` and `SO_REUSEPORT` so `lanname` coexists alongside `avahi-daemon` (Linux) or `mDNSResponder` (macOS).
   - Announces and answers `A` records (`TTL=120s`, `CacheFlush=0x8000`) for **all** configured service names (`hq.local`, `pool.local`, `nas.local`) plus the hub (`cofy.local`).
   - **IPv6 Dual-Stack Fast-Path:** Immediately answers `AAAA` queries for registered `.local` names with an authoritative `NOERROR` empty answer (`NODATA` + `NSEC`), preventing the 5-second IPv6 timeout seen on macOS/iOS/Windows/Linux dual-stack clients.
2. **Authoritative Local DNS + Forwarder (`UDP/TCP 53` — `internal/dnsserver`):**
   - Binds to `<LAN_IP>:53` (avoiding conflicts with `systemd-resolved` on `127.0.0.53:53`).
   - Resolves `*.cofy` and bare `cofy` to `<LAN_IP>` (`TTL=60s`).
   - **Browser DoH Canary Protection:** Answers `NXDOMAIN` to `use-application-dns.net.` and `_dns.resolver.arpa.` so Firefox and Chrome respect your local LAN DNS.
   - Forwards all other internet queries to `1.1.1.1:53` and `8.8.8.8:53`.
3. **Cross-Platform `/etc/hosts` Sync (`internal/hosts`):**
   - Maintains a clean fenced block (`# BEGIN LANNAME` ... `# END LANNAME`) in `/etc/hosts` (or `C:\Windows\System32\drivers\etc\hosts`) so `http://hq.cofy` resolves immediately on the host machine itself, cleaning up automatically on `SIGINT`/`SIGTERM`.
4. **HTTP & WebSocket Reverse Proxy + Onboarding Hub (`TCP 80` — `internal/proxy`, `internal/dashboard`):**
   - Routes `Host: hq.local` or `Host: hq.cofy` to `127.0.0.1:3100` with full WebSocket (`Upgrade: websocket`) support.
   - Renders a custom auto-retrying 502 error page if a backend container is restarting or stopped.
   - Serves the dark-mode **LAN Hub Dashboard** at `http://cofy.local` with live TCP health latency, offline SVG QR codes, browser-based service management, and a 1-click **iOS/macOS Split-DNS `.mobileconfig` generator** (`GET /setup/ios.mobileconfig`).

---

## Quickstart

### 1. Build from Source (Go 1.22+)

```bash
go mod tidy
go build -o lanname ./cmd/lanname
```

### 2. Grant Unprivileged Port 80 & 53 Binding on Linux (One-Liner)

To run `lanname` without `sudo` on Linux, grant `CAP_NET_BIND_SERVICE` to the compiled binary:

```bash
sudo setcap 'cap_net_bind_service=+ep' $(which lanname)
```

### 3. Start Serving Services

```bash
lanname serve hq=3100 pool=3001 nas=192.168.1.50:8080 --domain cofy
```

### 4. Hot-Reload Services at Runtime

```bash
# Add a new service to lanname.yaml and announce it immediately via mDNS + DNS:
lanname add plex=32400

# View active services and live TCP health:
lanname ls

# Remove a service:
lanname rm pool

# Run network & TLD safety diagnostics:
lanname doctor --domain cofy
```

---

## Running in Docker (`--net=host`)

Because Multicast DNS (`224.0.0.251:5353`) operates at Layer 2 on your physical LAN subnet, always run `lanname` with `--net=host` so multicast packets reach your Wi-Fi devices and `127.0.0.1:<port>` targets resolve to host services:

```bash
docker run -d \
  --name lanname \
  --net=host \
  --restart unless-stopped \
  -v $(pwd)/lanname.yaml:/app/lanname.yaml \
  -v /etc/hosts:/etc/hosts \
  lanname:latest serve hq=3100 pool=3001 nas=192.168.1.50:8080 --domain cofy
```
