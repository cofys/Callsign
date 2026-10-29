<div align="center">

# 📡 Callsign

### Clean, memorable URLs for your home network and Tailscale mesh.
**No router logins. No port numbers. Native MCP protocol for AI agents.**

[![Go Version](https://img.shields.io/badge/go-1.22+-00ADD8?style=flat&logo=go)](https://go.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-7.0-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Kotlin](https://img.shields.io/badge/Kotlin-1.9-7F52FF?style=flat&logo=kotlin&logoColor=white)](https://kotlinlang.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows%20%7C%20iOS%20%7C%20Android-lightgrey)](https://github.com/cofys/Callsign)
[![MCP Ready](https://img.shields.io/badge/MCP-streamable%20HTTP%20%2B%20stdio-purple)](https://modelcontextprotocol.io/)

```
http://plex.local  ──┐                                  ┌──► :32400 (Plex)
http://ha.x        ──┼──► [ Callsign :80 / :53 ] ───────┼──► :8123  (Home Assistant)
http://ollama.x    ──┘    (mDNS · Split-DNS · Proxy)    └──► :11434 (Ollama / Local LLM)
```

</div>

---

## ⚡ The Problem & The Fix

Every home app or dev server runs on an annoying IP and port (`http://192.168.1.50:32400`, `http://localhost:8123`, `http://localhost:11434`). Remembering ports across laptops, tablets, phones, and AI tools is painful.

**Callsign is a single, zero-dependency Go binary** that handles naming and port forwarding simultaneously:

- **Instant `.local` URLs** across macOS, iOS, Windows, and Linux via RFC 6762 mDNS (`http://plex.local`).
- **Any Custom Extension You Want**: `.a`, `.b`, `.c`, `.x`, `.hub`, `.lab`, `.home` — any extension is valid as long as it is **NOT a real public internet extension**.
- **Port-Free HTTP/WebSocket Reverse Proxy**: eliminates `:32400` and `:8123`; auto-reloads with zero downtime.
- **Tailscale Split-Horizon DNS**: queries from your home Wi-Fi get Gigabit LAN speeds; queries over Tailscale get your secure CGNAT IP (`100.x.y.z`).
- **Built-in Model Context Protocol (MCP)**: AI agents (Claude Desktop, Cursor, LangChain) can discover, resolve, and register routes autonomously.

```bash
# Start Callsign with single-letter ultra-short domain (.a, .b, .c, .x, etc.)
callsign serve plex=32400 ha=8123 nas=192.168.1.50:8080 --domain a
```

Open **`http://a.local`** (or **`http://plex.a`**) in your browser. Done.

---

## 🚀 Quickstart CLI

```bash
# Add an app (routes http://ollama.local & http://ollama.x -> 127.0.0.1:11434)
callsign add ollama=11434

# Add another machine on your Wi-Fi
callsign add cameras=192.168.1.90:8000

# View all active services & live health latencies
callsign ls

# Remove a service
callsign rm cameras

# Run a safety & port diagnosis
callsign doctor --domain a
```

---

## 🏷️ Create Any Custom Extension (`.a`, `.b`, `.c`, etc.)

You are **not locked into preset extensions**. Callsign gives you the freedom to choose any domain ending:
- **Ultra-fast 1-letter extensions**: `.a`, `.b`, `.c`, `.x`, `.z` — lightning quick to type on phones (`http://plex.a`, `http://ha.b`, `http://ollama.c`).
- **Custom words & abbreviations**: `.hub`, `.lab`, `.home`, `.lan`, `.box`, `.homelab`, `.base`.

> **The Only Rule:** As long as it is **NOT a real public internet extension** (like `.com`, `.net`, or HSTS-locked `.dev`), it works out of the box with zero router configuration. Callsign automatically validates your suffix so you never collide with real web traffic.

---

## 📦 Installation & System Setup

Find your platform below:


### 🍎 macOS Installation


#### 1. Install via Homebrew or Binary
```bash
# From source / Go toolchain
go install github.com/cofys/callsign/cmd/callsign@latest

# Or build locally
git clone https://github.com/cofys/Callsign.git
cd Callsign
go build -o /usr/local/bin/callsign ./cmd/callsign
```

#### 2. Run with Privileged Ports
```bash
# Run with privileged port 80 & 53 binding
sudo callsign serve --domain x
```
*Note: Callsign safely coexists with Apple's `mDNSResponder` on UDP port 5353 using `SO_REUSEPORT`.*

#### 3. iOS / iPadOS / macOS 1-Click Profile
Open **`http://x.local`** in Safari and click **Download Apple Split-DNS Profile** (`.mobileconfig`). This instructs iOS and macOS to resolve `*.x` through your Callsign daemon without touching your router's DHCP.



### 🐧 Linux Installation (Ubuntu, Debian, Arch, Fedora)


#### 1. Build and Install
```bash
git clone https://github.com/cofys/Callsign.git
cd Callsign
go build -o /usr/local/bin/callsign ./cmd/callsign
```

#### 2. Allow Port 80 & 53 Without Sudo
Grant the binary capability to bind privileged ports as a non-root user:
```bash
sudo setcap 'cap_net_bind_service=+ep' /usr/local/bin/callsign
```

#### 3. systemd Unit (`/etc/systemd/system/callsign.service`)
```ini
[Unit]
Description=Callsign Zero-Config LAN Naming Daemon
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/home/youruser
ExecStart=/usr/local/bin/callsign serve --domain x
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now callsign
```
*Note: Callsign automatically coexists with `systemd-resolved` by binding directly to your physical LAN IP rather than `127.0.0.53:53`. The optional `/etc/hosts` sync needs write access to `/etc/hosts` — under a non-root `User=` it is skipped, and names still resolve everywhere via DNS + mDNS.*



### 🪟 Windows Installation (10 & 11)


#### 1. Build from PowerShell
```powershell
git clone https://github.com/cofys/Callsign.git
cd Callsign
go build -o callsign.exe ./cmd/callsign
```

#### 2. Run in Administrator Terminal
```powershell
.\callsign.exe serve plex=32400 ha=8123 --domain x
```

#### 3. Windows Service (via WinSW or NSSM)
```powershell
nssm install Callsign "$PWD\callsign.exe" "serve --domain x"
nssm start Callsign
```
*Windows 10/11 natively resolves `.local` names out of the box via mDNS.*



### 🐳 Docker Setup

No official image is published yet — build the static binary and containerize it yourself:

```dockerfile
FROM alpine:latest
COPY callsign /usr/local/bin/callsign
ENTRYPOINT ["callsign"]
```

Because Multicast DNS (`224.0.0.251:5353`) broadcasts on physical L2 Wi-Fi, run the container with `--net=host`:

```bash
go build -o callsign ./cmd/callsign
docker build -t callsign .
docker run -d \
  --name callsign \
  --net=host \
  --restart unless-stopped \
  -v $(pwd)/callsign.yaml:/callsign.yaml \
  callsign serve plex=32400 ha=8123 --domain x --config /callsign.yaml --no-hosts
```

## 📱 Android Companion Setup


**[⬇️ Download the Companion APK](https://github.com/cofys/Callsign/raw/main/callsign-companion-universal.apk)** — open that link on your phone and install the file. (Your phone can't open the daemon's `.local` dashboard *before* the companion is installed — that's why the APK is here.) A running daemon also serves the same APK at `http://<daemon-ip>/setup/callsign-companion.apk` when a copy sits next to the daemon binary.

Chrome on stock Android ignores mDNS in the address bar. Callsign solves this without router changes via our lightweight **Android Split-DNS Companion**:

1. Install the APK from the download link above. Don't know the daemon's IP? Tap **Auto-Discover** in the app — it scans your Wi-Fi, finds the daemon, and fills in the IP and domain for you. Running several domains (say, one per project)? Enter them comma-separated in the domain field — e.g. `cofy,proj` — and the companion adds every one as a search domain. Running several *daemons* on different boxes? Auto-Discover adds them all to the app's Known Daemons list — and the daemons discover each other on the network and forward queries for each other's domains (and `.local` services), so any one daemon can answer every name on your network.
2. The companion runs a lightweight `VpnService` that redirects **only** `*.local` and your custom-domain DNS queries to Callsign.
3. **Evil-Twin Protected:** Before activating on any Wi-Fi, the companion verifies the daemon's identity records (`TXT _callsign.<domain>`). If you are on an untrusted public Wi-Fi, the companion stays dormant.
4. Zero traffic logging or full-tunnel routing—normal internet stays completely untouched.



## 🤖 AI Agents & MCP Protocol (Claude Desktop, Cursor, LangChain)


Callsign natively implements the **Model Context Protocol (MCP)** via both stdio and Streamable HTTP (`/mcp`):

### Claude Desktop (`claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "callsign": {
      "command": "callsign",
      "args": ["mcp"]
    }
  }
}
```

### HTTP Transport for Remote Agents
```bash
# Enable HTTP MCP at /mcp with mutation permissions and a Bearer token
callsign serve --domain x --agent-token=cs_secret_token --allow-agent-mutations
```

AI agents can now discover and register endpoints dynamically:
- `callsign_list_services`: List all reachable LAN & Tailscale services.
- `callsign_resolve`: Get direct upstream IP/port for a service name.
- `callsign_check_health`: Check upstream availability and latency.
- `callsign_register_service`: Register a new local service dynamically.
- `callsign_remove_service`: Deregister a service.


---

## 🌐 Remote Access with Tailscale (Split-Horizon DNS)

Callsign automatically detects your **Tailscale CGNAT interface** (`100.64.0.0/10` and `fd7a:115c:a1e0::/48`) and serves dual-view DNS:

1. In your [Tailscale Admin Console](https://login.tailscale.com/admin/dns), go to **DNS** ➔ **Nameservers** ➔ **Add Nameserver** ➔ **Custom**.
2. Enter your Callsign machine's Tailscale IP (e.g. `100.85.12.34`).
3. Check **Restrict to domain** and set it to `x`.

Now, opening `http://plex.x` or `http://ollama.x` works seamlessly from your phone over 5G, a laptop at a coffee shop, or a cloud VPS, routing through Tailscale to your home server.

---

## 🛡️ Architecture & Security

```
                   ┌───────────────────────────────────────────────┐
                   │             Callsign Single Binary            │
[UDP 5353] ────────┼─► mDNS Responder (RFC 6762 + AAAA Fast-Path) │
[UDP/TCP 53] ──────┼─► Authoritative DNS Server + DoH Canary Block │
[TCP 80] ──────────┼─► Reverse Proxy (WebSockets + 502 Auto-Retry) │
[/mcp] ────────────┼─► MCP Server (Host-Isolated, Token-Guarded)  │
[/etc/hosts] ──────┼─► Atomic Host Sync (# BEGIN CALLSIGN Block)   │
                   └───────────────────────────────────────────────┘
```

- **Private LAN & Tailscale ACL**: Port 53 only replies to loopback, RFC 1918 private subnets, and Tailscale CGNAT. Public internet lookups are strictly refused.
- **CSRF & DNS Rebinding Immunity**: All mutating REST endpoints require `Sec-Fetch-Site: same-origin` and verified `Host` headers.
- **Pre-validated TLD Guard**: Callsign blocks HSTS-preloaded suffixes (`.dev`, `.app`, `.page`) to protect you from browser HTTPS lockouts. Safe local suffixes like `.x`, `.home`, `.lan`, and `.lab` are fully supported.
- **Clean Uninstallation**: Exiting with `Ctrl+C` cleanly removes all `/etc/hosts` entries, restoring your machine immediately.

---

## ❓ FAQ


### Can I create my own extension like .a, .b, or .c?


Yes! You are not restricted to presets. You can choose **any custom extension** you want — ultra-short single letters (`.a`, `.b`, `.c`, `.x`, `.z`), abbreviations, or words (`.hub`, `.lab`, `.home`, `.lan`). The only rule: it must **not be a real public internet extension** (like `.com` or `.dev`). Pass `--domain <suffix>` when you start the daemon.



### What happens when a backend service is restarting?


Callsign serves an embedded, zero-dependency self-healing 502 status page. It polls `/__callsign_ping` in the background and automatically refreshes your browser the millisecond your app comes back up.



### Will this interfere with Docker or Pi-hole?


No. If port 53 is already taken by Pi-hole or AdGuard Home on all interfaces, Callsign can run with `--no-dns` (relying on mDNS and `/etc/hosts`) or bind to a secondary IP.


---

## 📄 License

MIT © [Cofys](https://github.com/cofys)
