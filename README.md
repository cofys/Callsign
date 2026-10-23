# `lanname` — Clean URLs for Your Home Network

`lanname` is a single-binary Go daemon that turns messy IP-and-port bookmarks like `http://192.168.1.50:3100` into clean, memorable names like **`http://hq.local`** and **`http://hq.home`** across your laptops, phones, and tablets.

```bash
lanname serve hq=3100 pool=3001 nas=192.168.1.50:8080 --domain home
```

No router login required, no manual `/etc/hosts` editing on every device, and no YAML boilerplate required to get started.

---

## Why `lanname`?

When you run apps at home—like Plex, Home Assistant, Jellyfin, Ollama, or your own dev servers—every app runs on a different port (`:3100`, `:8123`, `:32400`). Remembering IP addresses and port numbers on every device is tedious.

`lanname` solves both **naming** (DNS) and **port removal** (reverse proxy) in a single lightweight process:

| What You Type in Your Browser | Where `lanname` Routes It | How Devices Find It |
| :--- | :--- | :--- |
| `http://hq.local` or `http://hq.home` | `http://127.0.0.1:3100` | Instant mDNS (`.local`) + Local DNS (`.home`) |
| `http://pool.local` or `http://pool.home` | `http://127.0.0.1:3001` | Instant mDNS (`.local`) + Local DNS (`.home`) |
| `http://nas.local` or `http://nas.home` | `http://192.168.1.50:8080` | Instant mDNS (`.local`) + Local DNS (`.home`) |
| `http://home.local` or `http://home` | **Built-in Live Dashboard** | Shows health status, QR codes & mobile setup |

---

## 60-Second Quickstart

### 1. Build the Binary (Go 1.22+)

```bash
go mod tidy
go build -o lanname ./cmd/lanname
```

### 2. Allow Port 80 & 53 Without `sudo` (Linux One-Liner)

On Linux, grant the binary permission to bind ports 80 and 53 as a normal user:

```bash
sudo setcap 'cap_net_bind_service=+ep' $(which lanname)
```

*(If you skip this step and run without root, `lanname` won't crash—it automatically falls back to unprivileged ports like `:8080` and prints the exact command above if you want port-free URLs later.)*

### 3. Start Serving Your Apps

Pass any `name=port` or `name=ip:port` pairs directly on the command line:

```bash
lanname serve hq=3100 pool=3001 nas=192.168.1.50:8080 --domain home
```

Open **`http://home.local`** (or **`http://hq.local`**) in your browser.

### 4. Add or Remove Apps Anytime (Zero Downtime)

You don't need to restart the daemon to add new services. `lanname` saves your changes to `lanname.yaml` and hot-reloads live:

```bash
# Add a local port (routes http://plex.local & http://plex.home -> 127.0.0.1:32400)
lanname add plex=32400

# Add another machine on your LAN
lanname add cameras=192.168.1.90:8000

# List all active services and their live health latency
lanname ls

# Remove a service
lanname rm pool

# Check your network, ports, and domain safety
lanname doctor --domain home
```

---

## How It Works Under the Hood

When you run `lanname serve`, one Go binary runs four small subsystems together:

1. **Multi-Host mDNS Responder (`UDP 5353` — `internal/mdns`):**
   - Announces all of your services (`hq.local`, `pool.local`, `nas.local`) on your Wi-Fi subnet at once.
   - Shares port `5353` peacefully with macOS `mDNSResponder` and Linux `avahi-daemon` using `SO_REUSEADDR` / `SO_REUSEPORT`.
   - Includes a **Dual-Stack Fast-Path** that answers IPv6 `AAAA` queries with an immediate empty `NOERROR` (`NODATA`), eliminating the 5-second delay common on Macs and iPhones.
2. **Authoritative Local DNS Server (`UDP/TCP 53` — `internal/dnsserver`):**
   - Resolves your custom domain (`*.home`, `*.cofy`, `*.lan`) to your host's LAN IP.
   - Automatically blocks browser DoH canary domains (`use-application-dns.net` -> `NXDOMAIN`) so Firefox and Chrome don't bypass your local names.
   - Forwards normal internet lookups upstream (`1.1.1.1`, `8.8.8.8`).
3. **Automatic `/etc/hosts` Sync (`internal/hosts`):**
   - Maintains a clean `# BEGIN LANNAME` ... `# END LANNAME` block on the host computer so `http://hq.home` works immediately on the machine running `lanname`, and removes it cleanly when stopped.
4. **HTTP & WebSocket Reverse Proxy + Dashboard (`TCP 80` — `internal/proxy`, `internal/dashboard`):**
   - Routes incoming requests by their `Host` header (`hq.local` or `hq.home` -> `127.0.0.1:3100`) with full WebSocket support.
   - Shows a **Self-Healing 502 Page** if a backend app is rebooting, automatically refreshing your browser the moment the app comes back online.

---

## Connecting Phones, Tablets & Laptops

| Device Type | How `*.local` Works | How Custom Domains (`*.home`, `*.cofy`) Work |
| :--- | :--- | :--- |
| **Mac, iPhone, iPad** | Works out of the box (0 setup) | **1-Click Profile:** Open `http://home.local` on your device and tap **Download iOS/macOS Split-DNS Profile** (`.mobileconfig`). |
| **Windows 10 / 11 & Linux** | Works out of the box (0 setup) | Automatic on the host via `/etc/hosts`, or point Wi-Fi/Router DNS to the `lanname` IP. |
| **Android Phones** | Chrome on stock Android ignores mDNS in the URL bar | Use the included **Android Split-DNS Companion** (`android/LannameVpnService.kt`) or set your Wi-Fi Router's Primary DNS to your `lanname` host IP. |

---

## Running with Docker

Because Multicast DNS (`224.0.0.251:5353`) talks directly to your physical Wi-Fi network, run the container with `--net=host`:

```bash
docker run -d \
  --name lanname \
  --net=host \
  --restart unless-stopped \
  -v $(pwd)/lanname.yaml:/app/lanname.yaml \
  -v /etc/hosts:/etc/hosts \
  lanname:latest serve hq=3100 pool=3001 nas=192.168.1.50:8080 --domain home
```

---

## Frequently Asked Questions (FAQ)

### 1. Can I use my own custom domain suffix and service prefixes?
**Yes!** `.local` and `.cofy` are just examples.
- **Custom Prefixes:** You can name any port whatever you want (`lanname add movies=32400`, `lanname add ai=11434`).
- **Custom Domain Suffix:** Pass `--domain <anything>` (for example `--domain home`, `--domain lan`, `--domain lab`, or your family name). Every service automatically gets **both** `<name>.local` and `<name>.<domain>`.

### 2. Why does `lanname` block `.dev`, `.app`, and `.page` by default?
Google and browser vendors placed `.dev`, `.app`, `.page`, `.new`, and `.foo` on the **HSTS Preload List** baked into Chrome, Safari, Firefox, and Edge. Browsers refuse to connect to those domains over plain `http://` on a local network. `lanname` warns you and blocks these suffixes up front so you never spend hours debugging browser HTTPS errors. Safe private suffixes like `.home`, `.lan`, `.lab`, `.box`, and `.cofy` work over plain HTTP without warnings.

### 3. Why do `*.local` links work on iPhones, Macs, and Windows PCs, but fail on stock Android browsers?
Apple devices (via Bonjour), Windows 10/11, and Linux resolve `.local` names using Multicast DNS (UDP port 5353). However, stock Android's browser stack (Chrome / One UI) does not send mDNS queries for `.local` URLs typed into the address bar—it sends them to your Wi-Fi router's DNS server, which immediately returns `NXDOMAIN` ("domain does not exist").

Even if you advertise an IPv6 RDNSS server on your LAN, Android treats the router's `NXDOMAIN` response as final and never checks secondary DNS servers. To solve this without touching your router, we include **`android/LannameVpnService.kt`**—a lightweight Android `VpnService` Split-DNS companion that points `.local` and `.<domain>` lookups directly to your `lanname` daemon while on home Wi-Fi.

### 4. Is the Android `VpnService` companion safe when I leave home and join public Wi-Fi?
**Yes—it is specifically hardened against public Wi-Fi subnet collisions ("Evil-Twin" networks).**
Many coffee shops and hotels use `192.168.1.0/24`. If a naive VPN app blindly sent DNS queries to `192.168.1.159` on a coffee-shop network, your internet would break—or worse, another laptop at `192.168.1.159` could intercept your DNS lookups.
- **Cryptographic Identity Check:** Your `lanname` daemon generates a unique cryptographic `instance_id` (`ln-...`) in `lanname.yaml` and serves it via `TXT _lanname.<domain>.` and `GET /api/identity`.
- **Verify Before Activating:** Whenever your Android phone joins a Wi-Fi network, `LannameVpnService` probes the LAN IP over the raw Wi-Fi socket first. If the host does not return your exact `instance_id` within `600ms`, the VPN stays completely dormant.
- **Split-DNS Only (Zero Traffic Inspection):** The companion only configures a `/32` DNS anchor (`10.254.254.1/32`), never a `0.0.0.0/0` full-tunnel route. None of your internet traffic passes through a VPN tunnel, and the shim shuts down in `<50ms` the moment you leave Wi-Fi.

### 5. Is the `lanname` daemon itself secure on my network?
Yes. Three built-in protections are always active:
1. **Private LAN ACL on Port 53:** The DNS server verifies the source IP of every packet (`isPrivateOrLocalClient`) and only answers Loopback (`127.0.0.1`), Private LAN (`10.x`, `172.16-31.x`, `192.168.x`), Link-Local, and IPv6 ULA (`fc00::/7`) addresses. Even if a router accidentally exposed port 53 via UPnP, public internet queries receive `REFUSED`.
2. **CSRF & DNS-Rebinding Protection:** Mutating API endpoints (`POST /api/services` and `DELETE /api/services/*`) verify `Sec-Fetch-Site: same-origin`, `Origin`, and an explicit `Host` header allowlist so a malicious external website opened in your browser cannot add or alter routes on your LAN.
3. **Loopback-Only CLI Admin Socket:** CLI hot-reload commands (`lanname add` / `lanname rm`) communicate over `127.0.0.1:43199`, which is unreachable from other machines.

### 6. Will `lanname` conflict with `systemd-resolved` (Ubuntu/Debian), `avahi-daemon`, or macOS?
No.
- **Port 53 (Unicast DNS):** On Linux systems running `systemd-resolved` (which binds `127.0.0.53:53`), `lanname` binds directly to your primary LAN IP (e.g., `192.168.1.159:53`) instead of `0.0.0.0:53`, avoiding port conflicts entirely.
- **Port 5353 (mDNS):** `lanname` sets `SO_REUSEADDR` and `SO_REUSEPORT` on its multicast socket so it runs side-by-side with `avahi-daemon` or macOS `mDNSResponder`.

### 7. What happens if I stop `lanname` or restart my computer?
When you press `Ctrl+C` (or send `SIGTERM`), `lanname` cleanly removes the `# BEGIN LANNAME` ... `# END LANNAME` block from `/etc/hosts` before exiting, leaving your system configuration untouched. Your service mappings stay saved in `lanname.yaml` for the next time you run `lanname serve`.
