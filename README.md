# `Callsign` — Clean URLs for Your Home Network

`Callsign` (`callsign`) is a single-binary Go daemon that turns messy IP-and-port bookmarks like `http://192.168.1.50:32400` into clean, memorable names like **`http://plex.local`** and **`http://plex.x`** across your laptops, phones, and tablets.

```bash
callsign serve plex=32400 ha=8123 nas=192.168.1.50:8080 --domain x
```

No router login required, no manual `/etc/hosts` editing on every device, and no YAML boilerplate required to get started.

---

## Why `Callsign`?

When you run apps at home—like Plex, Home Assistant, Jellyfin, Ollama, or your own dev servers—every app runs on a different port (`:32400`, `:8123`, `:8096`). Remembering IP addresses and port numbers on every device is tedious.

`Callsign` solves both **naming** (DNS) and **port removal** (reverse proxy) in a single lightweight process:

| What You Type in Your Browser | Where `Callsign` Routes It | How Devices Find It |
| :--- | :--- | :--- |
| `http://plex.local` or `http://plex.x` | `http://127.0.0.1:32400` | Instant mDNS (`.local`) + Local DNS (`.x`) |
| `http://ha.local` or `http://ha.x` | `http://127.0.0.1:8123` | Instant mDNS (`.local`) + Local DNS (`.x`) |
| `http://nas.local` or `http://nas.x` | `http://192.168.1.50:8080` | Instant mDNS (`.local`) + Local DNS (`.x`) |
| `http://x.local` or `http://x` | **Built-in Live Dashboard** | Shows health status, QR codes & mobile setup |

---

## 60-Second Quickstart

### 1. Build the Binary (Go 1.22+)

```bash
go mod tidy
go build -o callsign ./cmd/callsign
```

### 2. Allow Port 80 & 53 Without `sudo` (Linux One-Liner)

On Linux, grant the binary permission to bind ports 80 and 53 as a normal user:

```bash
sudo setcap 'cap_net_bind_service=+ep' $(which callsign)
```

*(If you skip this step and run without root, `callsign` won't crash—it automatically falls back to unprivileged ports like `:8080` and prints the exact command above if you want port-free URLs later.)*

### 3. Start Serving Your Apps

Pass any `name=port` or `name=ip:port` pairs directly on the command line:

```bash
callsign serve plex=32400 ha=8123 nas=192.168.1.50:8080 --domain x
```

Open **`http://x.local`** (or **`http://plex.local`**) in your browser.

### 4. Add or Remove Apps Anytime (Zero Downtime)

You don't need to restart the daemon to add new services. `callsign` saves your changes to `callsign.yaml` and hot-reloads live:

```bash
# Add a local port (routes http://jellyfin.local & http://jellyfin.x -> 127.0.0.1:8096)
callsign add jellyfin=8096

# Add another machine on your LAN
callsign add cameras=192.168.1.90:8000

# List all active services and their live health latency
callsign ls

# Remove a service
callsign rm jellyfin

# Check your network, ports, and domain safety
callsign doctor --domain x
```

---

## How It Works Under the Hood

When you run `callsign serve`, one Go binary runs four small subsystems together:

1. **Multi-Host mDNS Responder (`UDP 5353` — `internal/mdns`):**
   - Announces all of your services (`plex.local`, `ha.local`, `nas.local`) on your Wi-Fi subnet at once.
   - Shares port `5353` peacefully with macOS `mDNSResponder` and Linux `avahi-daemon` using `SO_REUSEADDR` / `SO_REUSEPORT`.
   - Includes a **Dual-Stack Fast-Path** that answers IPv6 `AAAA` queries with an immediate empty `NOERROR` (`NODATA`), eliminating the 5-second delay common on Macs and iPhones.
2. **Authoritative Local DNS Server (`UDP/TCP 53` — `internal/dnsserver`):**
   - Resolves your custom domain (`*.x`, `*.home`, `*.lan`) to your host's LAN IP.
   - Automatically blocks browser DoH canary domains (`use-application-dns.net` -> `NXDOMAIN`) so Firefox and Chrome don't bypass your local names.
   - Forwards normal internet lookups upstream (`1.1.1.1`, `8.8.8.8`).
3. **Automatic `/etc/hosts` Sync (`internal/hosts`):**
   - Maintains a clean `# BEGIN CALLSIGN` ... `# END CALLSIGN` block on the host computer so `http://plex.x` works immediately on the machine running `callsign`, and removes it cleanly when stopped.
4. **HTTP & WebSocket Reverse Proxy + Dashboard (`TCP 80` — `internal/proxy`, `internal/dashboard`):**
   - Routes incoming requests by their `Host` header (`plex.local` or `plex.x` -> `127.0.0.1:32400`) with full WebSocket support.
   - Shows a **Self-Healing 502 Page** if a backend app is rebooting, automatically refreshing your browser the moment the app comes back online.

---

## Connecting Phones, Tablets & Laptops

| Device Type | How `*.local` Works | How Custom Domains (`*.x`, `*.home`) Work |
| :--- | :--- | :--- |
| **Mac, iPhone, iPad** | Works out of the box (0 setup) | **1-Click Profile:** Open `http://x.local` on your device and tap **Download iOS/macOS Split-DNS Profile** (`.mobileconfig`). |
| **Windows 10 / 11 & Linux** | Works out of the box (0 setup) | Automatic on the host via `/etc/hosts`, or point Wi-Fi/Router DNS to the `Callsign` IP. |
| **Android Phones** | Chrome on stock Android ignores mDNS in the URL bar | Use the included **Callsign Android Companion APK** (`android/CallsignVpnService.kt`) or set your Wi-Fi Router's Primary DNS to your `Callsign` host IP. |

---

## Running with Docker

Because Multicast DNS (`224.0.0.251:5353`) talks directly to your physical Wi-Fi network, run the container with `--net=host`:

```bash
docker run -d \
  --name callsign \
  --net=host \
  --restart unless-stopped \
  -v $(pwd)/callsign.yaml:/app/callsign.yaml \
  -v /etc/hosts:/etc/hosts \
  callsign:latest serve plex=32400 ha=8123 --domain x
```

---

## Anywhere Access with Tailscale (Split-Horizon DNS)

`Callsign` automatically detects your **Tailscale CGNAT IP** (`100.64.0.0/10`) and **IPv6 ULA** (`fd7a:115c:a1e0::/48`) interface and runs a **Source-IP Split-Horizon DNS Server**:

- **On Home Wi-Fi (`192.168.x.x`):** Queries for `plex.x` or `ollama.x` return your direct LAN IP (`192.168.1.100`) for full Gigabit LAN speed.
- **On Tailscale (`100.64.0.0/10` — 5G, coffee shop, remote VPS):** Queries for `plex.x` or `ollama.x` automatically return your host's Tailscale IP (`100.85.12.34`).
- **Works for Non-Tailscale LAN Appliances:** Even if your NAS (`192.168.1.50:8080`) or IoT devices cannot run Tailscale, `Callsign` reverse-proxies `http://nas.x` from your Tailscale interface onto your home LAN with **zero Subnet Router configuration**.

### 30-Second Tailscale Setup:
1. Open your [Tailscale Admin DNS Console](https://login.tailscale.com/admin/dns).
2. Click **Add Nameserver -> Custom**, enter your Callsign host's Tailscale IP (e.g. `100.85.12.34`), and enable **Restrict to domain**: `x`.
3. Every device and cloud AI agent on your tailnet can now open `http://plex.x`, `http://ha.x`, and `http://ollama.x` from anywhere in the world.

---

## Built-In AI Agent & MCP Server (`callsign mcp`)

AI agents (Claude Desktop, Cursor, Windsurf, Cline, LangChain, OpenAI/Gemini tool-calling bots) can discover and resolve your local services without hardcoding ports:

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

- **Zero-Trust by Default:** Read-only discovery tools (`callsign_list_services`, `callsign_resolve`, `callsign_check_health`) are enabled by default for verified LAN/Tailscale peers.
- **Scoped Bearer Token for Mutations:** Registering or removing routes (`callsign_register_service`, `callsign_remove_service`) requires explicit opt-in (`--allow-agent-mutations`) and a valid `Authorization: Bearer cs_tok_...` token over HTTP (`/mcp`).

---

## Frequently Asked Questions (FAQ)

### 1. Can I use my own custom domain suffix and service prefixes?
**Yes!** `.local` and `.x` are just defaults.
- **Custom Prefixes:** You can name any port whatever you want (`callsign add movies=32400`, `callsign add ai=11434`).
- **Custom Domain Suffix:** Pass `--domain <anything>` (for example `--domain x`, `--domain home`, `--domain lan`, `--domain lab`, or your family name). Every service automatically gets **both** `<name>.local` and `<name>.<domain>`.

### 2. Why does `Callsign` block `.dev`, `.app`, and `.page` by default?
Google and browser vendors placed `.dev`, `.app`, `.page`, `.new`, and `.foo` on the **HSTS Preload List** baked into Chrome, Safari, Firefox, and Edge. Browsers refuse to connect to those domains over plain `http://` on a local network. `Callsign` warns you and blocks these suffixes up front so you never spend hours debugging browser HTTPS errors. Safe private suffixes like `.x`, `.home`, `.lan`, `.lab`, and `.box` work over plain HTTP without warnings.

### 3. Why do `*.local` links work on iPhones, Macs, and Windows PCs, but fail on stock Android browsers?
Apple devices (via Bonjour), Windows 10/11, and Linux resolve `.local` names using Multicast DNS (UDP port 5353). However, stock Android's browser stack (Chrome / One UI) does not send mDNS queries for `.local` URLs typed into the address bar—it sends them to your Wi-Fi router's DNS server, which immediately returns `NXDOMAIN` ("domain does not exist").

Even if you advertise an IPv6 RDNSS server on your LAN, Android treats the router's `NXDOMAIN` response as final and never checks secondary DNS servers. To solve this without touching your router, we include the **Callsign Android Split-DNS Companion**—a lightweight Android `VpnService` companion APK that points `.local` and `.<domain>` lookups directly to your `Callsign` daemon while on home Wi-Fi.

### 4. Is the Android `VpnService` companion safe when I leave home and join public Wi-Fi?
**Yes—it is specifically hardened against public Wi-Fi subnet collisions ("Evil-Twin" networks).**
Many coffee shops and hotels use `192.168.1.0/24`. If a naive VPN app blindly sent DNS queries to `192.168.1.159` on a coffee-shop network, your internet would break—or worse, another laptop at `192.168.1.159` could intercept your DNS lookups.
- **Cryptographic Identity Check:** Your `Callsign` daemon generates a unique cryptographic `instance_id` (`cs-...`) in `callsign.yaml` and serves it via `TXT _callsign.<domain>.` and `GET /api/identity`.
- **Verify Before Activating:** Whenever your Android phone joins a Wi-Fi network, the companion service probes the LAN IP over the raw Wi-Fi socket first. If the host does not return your exact `instance_id` within `600ms`, the VPN stays completely dormant.
- **Split-DNS Only (Zero Traffic Inspection):** The companion only configures a `/32` DNS anchor (`10.254.254.1/32`), never a `0.0.0.0/0` full-tunnel route. None of your internet traffic passes through a VPN tunnel, and the shim shuts down in `<50ms` the moment you leave Wi-Fi.

### 5. Is the `Callsign` daemon itself secure on my network?
Yes. Three built-in protections are always active:
1. **Private LAN + Tailscale CGNAT ACL on Port 53:** The DNS server verifies the source IP of every packet (`isPrivateOrLocalClient`) and only answers Loopback (`127.0.0.1`), Private LAN (`10.x`, `172.16-31.x`, `192.168.x`), Tailscale CGNAT (`100.64.0.0/10`), Link-Local, and IPv6 ULA (`fc00::/7`) addresses. Even if a router accidentally exposed port 53 via UPnP, public internet queries receive `REFUSED`.
2. **CSRF & DNS-Rebinding Protection:** Mutating API endpoints (`POST /api/services` and `DELETE /api/services/*`) verify `Sec-Fetch-Site: same-origin`, `Origin`, and an explicit `Host` header allowlist so a malicious external website opened in your browser cannot add or alter routes on your LAN.
3. **Loopback-Only CLI Admin Socket:** CLI hot-reload commands (`callsign add` / `callsign rm`) communicate over `127.0.0.1:43199`, which is unreachable from other machines.

### 6. Will `Callsign` conflict with `systemd-resolved` (Ubuntu/Debian), `avahi-daemon`, or macOS?
No.
- **Port 53 (Unicast DNS):** On Linux systems running `systemd-resolved` (which binds `127.0.0.53:53`), `Callsign` binds directly to your primary LAN IP (e.g., `192.168.1.159:53`) and Tailscale IP (`100.85.12.34:53`) instead of `0.0.0.0:53`, avoiding port conflicts entirely.
- **Port 5353 (mDNS):** `Callsign` sets `SO_REUSEADDR` and `SO_REUSEPORT` on its multicast socket so it runs side-by-side with `avahi-daemon` or macOS `mDNSResponder`.

### 7. What happens if I stop `Callsign` or restart my computer?
When you press `Ctrl+C` (or send `SIGTERM`), `Callsign` cleanly removes the `# BEGIN CALLSIGN` ... `# END CALLSIGN` block from `/etc/hosts` before exiting, leaving your system configuration untouched. Your service mappings stay saved in `callsign.yaml` for the next time you run `callsign serve`.
