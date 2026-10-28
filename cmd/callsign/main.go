package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"text/tabwriter"
	"time"

	"github.com/cofys/callsign/internal/config"
	"github.com/cofys/callsign/internal/dashboard"
	"github.com/cofys/callsign/internal/dnsserver"
	"github.com/cofys/callsign/internal/hosts"
	"github.com/cofys/callsign/internal/mcp"
	"github.com/cofys/callsign/internal/mdns"
	"github.com/cofys/callsign/internal/netutil"
	"github.com/cofys/callsign/internal/proxy"
	"github.com/cofys/callsign/internal/tld"
)

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}

	subcmd := os.Args[1]
	args := os.Args[2:]

	var err error
	switch subcmd {
	case "serve":
		err = runServe(args)
	case "add":
		err = runAdd(args)
	case "rm", "remove":
		err = runRemove(args)
	case "ls", "list", "status":
		err = runList(args)
	case "doctor":
		err = runDoctor(args)
	case "mcp":
		err = runMCP(args)
	case "-h", "--help", "help":
		printUsage()
		return
	default:
		// Convenience: if first arg contains '=', treat as `callsign serve ...`
		if strings.Contains(subcmd, "=") {
			err = runServe(os.Args[1:])
		} else {
			fmt.Fprintf(os.Stderr, "Unknown command %q\n\n", subcmd)
			printUsage()
			os.Exit(1)
		}
	}

	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Println(`Callsign — Zero-Config LAN & Tailscale Naming + AI Agent MCP Daemon

Usage:
  callsign serve [name=target...] [--domain x] [--http-port 80] [--dns-port 53] [--config callsign.yaml] [--no-dns] [--no-hosts] [--allow-agent-mutations] [--agent-token <token>]
  callsign add <name=target> [--config callsign.yaml]
  callsign rm <name> [--config callsign.yaml]
  callsign ls [--config callsign.yaml] [--json]
  callsign mcp [--config callsign.yaml] [--allow-agent-mutations] [--agent-token <token>]
  callsign doctor [--domain x]

Examples:
  callsign serve plex=32400 ha=8123 ollama=11434 --domain x
  callsign add jellyfin=8096
  callsign mcp --allow-agent-mutations
  callsign doctor --domain x`)
}

// runServe implements `callsign serve [name=target...] [flags]`.
func runServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	domainFlag := fs.String("domain", "", "Custom local domain suffix (e.g. x, lan, home)")
	httpPortFlag := fs.Int("http-port", 0, "HTTP & WebSocket reverse proxy port (default 80)")
	dnsPortFlag := fs.Int("dns-port", 0, "Authoritative DNS + Forwarder port (default 53)")
	configPath := fs.String("config", config.DefaultConfigPath, "Path to callsign.yaml")
	noDNS := fs.Bool("no-dns", false, "Disable unicast DNS server on port 53")
	noHosts := fs.Bool("no-hosts", false, "Disable /etc/hosts synchronization")
	forceTLD := fs.Bool("force", false, "Override Red HSTS-preloaded TLD block")
	allowMutations := fs.Bool("allow-agent-mutations", false, "Allow AI agents to register or remove services")
	agentToken := fs.String("agent-token", "", "Bearer token required for mutating agent tool calls over /mcp")

	// Allow flags and positional name=target arguments in any order
	var pairs []string
	var flagArgs []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		if strings.HasPrefix(a, "-") {
			flagArgs = append(flagArgs, a)
			if (a == "--domain" || a == "-domain" ||
				a == "--http-port" || a == "-http-port" ||
				a == "--dns-port" || a == "-dns-port" ||
				a == "--config" || a == "-config" ||
				a == "--agent-token" || a == "-agent-token") && i+1 < len(args) {
				i++
				flagArgs = append(flagArgs, args[i])
			}
		} else {
			pairs = append(pairs, a)
		}
	}

	if err := fs.Parse(flagArgs); err != nil {
		return err
	}
	pairs = append(pairs, fs.Args()...)

	store := config.NewStore(*configPath)
	if err := store.Load(); err != nil {
		return err
	}

	store.SetRuntimeFlags(*domainFlag, *httpPortFlag, *dnsPortFlag, *noDNS, *noHosts)

	// Validate the chosen domain suffix against the 3-Tier TLD Safety Classifier
	tldRes := tld.Validate(store.Domain(), *forceTLD)
	if tldRes.Tier == tld.TierRed {
		if tldRes.Blocked {
			return fmt.Errorf("[TLD SAFETY BLOCK] %s: %s", tldRes.Title, tldRes.Message)
		}
		fmt.Fprintf(os.Stderr, "⚠️  [TLD WARNING - FORCED] %s: %s\n", tldRes.Title, tldRes.Message)
	} else if tldRes.Tier == tld.TierYellow {
		fmt.Fprintf(os.Stderr, "⚠️  [%s] %s\n", tldRes.Title, tldRes.Message)
	}

	for _, expr := range pairs {
		svc, err := config.ParseServicePair(expr)
		if err != nil {
			return err
		}
		store.Upsert(svc)
	}

	if err := store.Save(); err != nil {
		fmt.Fprintf(os.Stderr, "⚠️  Could not save %s: %v\n", store.Path(), err)
	}

	lanIP, ifaceName, err := netutil.PrimaryLANIPv4()
	if err != nil {
		lanIP = net.ParseIP("127.0.0.1")
		ifaceName = "loopback"
		fmt.Fprintf(os.Stderr, "⚠️  Could not detect LAN IPv4 (%v); falling back to 127.0.0.1\n", err)
	}

	if isolated, reason := netutil.ContainerNotice(); isolated {
		fmt.Fprintf(os.Stderr, "⚠️  [CONTAINER NOTICE] %s\n", reason)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	hostsMgr := hosts.NewManager()

	// Helper to compute all .local hostnames for mDNS and sync /etc/hosts
	buildMDNSHostnames := func() []string {
		domain := store.Domain()
		svcs := store.List()
		names := []string{domain + ".local"}
		svcNames := make([]string, 0, len(svcs))
		for _, s := range svcs {
			names = append(names, s.Name+".local")
			svcNames = append(svcNames, s.Name)
		}
		if !store.NoHosts() {
			if err := hostsMgr.Sync(lanIP, domain, svcNames); err != nil {
				// Non-fatal if run without root privileges
			}
		}
		return names
	}

	// 1. Start Multi-Alias mDNS Responder on UDP 5353
	mdnsResponder, mdnsErr := mdns.NewResponder(lanIP, buildMDNSHostnames())
	if mdnsErr != nil {
		fmt.Fprintf(os.Stderr, "⚠️  mDNS responder (UDP 5353) unavailable: %v\n", mdnsErr)
	} else {
		go mdnsResponder.Start(ctx)
		defer mdnsResponder.Close()
	}

	// Register live hot-reload hook whenever services change via API or `callsign add/rm`
	store.OnChange(func() {
		names := buildMDNSHostnames()
		if mdnsResponder != nil {
			mdnsResponder.SetHostnames(names)
		}
	})

	// 2. Start Authoritative Local DNS Server + Forwarder on UDP/TCP 53
	var dnsBound []string
	var dnsSrv *dnsserver.Server
	if !store.NoDNS() {
		dnsSrv = dnsserver.New(store, lanIP)
		bound, err := dnsSrv.Start(ctx)
		if err != nil {
			fmt.Fprintf(os.Stderr, "⚠️  DNS server (port %d) not bound: %v (mDNS .local still works!)\n", store.DNSPort(), err)
		} else {
			dnsBound = bound
			defer dnsSrv.Close()
		}
	}

	// 3. Start Dashboard + Streamable HTTP MCP (/mcp) + HTTP/WebSocket Reverse Proxy on TCP 80
	tsIP, _ := netutil.TailscaleIPv4()
	mcpSrv := mcp.NewServer(store, lanIP, tsIP, *allowMutations, *agentToken)

	dashHandler := dashboard.NewHandler(store, lanIP)
	dashHandler.SetTailscaleIP(tsIP)
	dashHandler.SetMCPHandler(mcpSrv)
	defer dashHandler.Close()

	proxyRouter := proxy.NewRouter(store, lanIP, dashHandler)
	proxyRouter.SetTailscaleIP(tsIP)
	httpAddr := fmt.Sprintf("0.0.0.0:%d", store.HTTPPort())
	httpLn, err := net.Listen("tcp4", httpAddr)
	if err != nil {
		return fmt.Errorf("bind HTTP proxy on %s: %w (on Linux, run: sudo setcap 'cap_net_bind_service=+ep' $(which callsign) or pass --http-port 8080)", httpAddr, err)
	}

	httpServer := &http.Server{
		Handler:           proxyRouter,
		ReadHeaderTimeout: 10 * time.Second,
	}

	// 4. Start Local Admin Control Socket (127.0.0.1:43199) for hot-reload via `callsign add` / `callsign rm` / `callsign ls`
	adminServer := startAdminServer(dashHandler)
	defer func() {
		if adminServer != nil {
			_ = adminServer.Close()
		}
	}()

	printStartupBanner(store, lanIP, ifaceName, mdnsErr == nil, dnsBound)

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownCtx)
	}()

	if err := httpServer.Serve(httpLn); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}

	if !store.NoHosts() {
		_ = hostsMgr.Cleanup()
	}
	fmt.Println("\nCallsign stopped cleanly.")
	return nil
}

func startAdminServer(dashHandler *dashboard.Handler) *http.Server {
	ln, err := net.Listen("tcp4", config.DefaultAdminAddr)
	if err != nil {
		return nil
	}
	srv := &http.Server{
		Handler:           dashHandler,
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		_ = srv.Serve(ln)
	}()
	return srv
}

func printStartupBanner(store *config.Store, lanIP net.IP, iface string, mdnsActive bool, dnsBound []string) {
	domain := store.Domain()
	portSuffix := ""
	if store.HTTPPort() != 80 {
		portSuffix = fmt.Sprintf(":%d", store.HTTPPort())
	}

	fmt.Println("╭──────────────────────────────────────────────────────────────────────────╮")
	fmt.Printf("│  Callsign daemon online · LAN IP: %-15s (%s)%*s│\n", lanIP.String(), iface, maxInt(0, 20-len(iface)), "")
	fmt.Println("╰──────────────────────────────────────────────────────────────────────────╯")
	fmt.Printf("  Dashboard Hub   : http://%s.local%s  |  http://%s%s\n", domain, portSuffix, domain, portSuffix)
	if mdnsActive {
		fmt.Printf("  mDNS Responder  : UDP 224.0.0.251:5353 (A + immediate AAAA NODATA)\n")
	}
	if len(dnsBound) > 0 {
		fmt.Printf("  Local DNS       : %s (*.%s + DoH Canary NXDOMAIN)\n", strings.Join(dnsBound, ", "), domain)
	}
	fmt.Printf("  iOS DNS Profile : http://%s.local%s/setup/ios.mobileconfig\n\n", domain, portSuffix)

	tw := tabwriter.NewWriter(os.Stdout, 0, 0, 3, ' ', 0)
	fmt.Fprintln(tw, "  SERVICE\tINSTANT mDNS (.local)\tCUSTOM DOMAIN\tUPSTREAM TARGET")
	fmt.Fprintln(tw, "  ───────\t─────────────────────\t─────────────\t───────────────")
	for _, s := range store.List() {
		fmt.Fprintf(
			tw,
			"  %s\thttp://%s.local%s\thttp://%s.%s%s\t%s\n",
			s.Name,
			s.Name,
			portSuffix,
			s.Name,
			domain,
			portSuffix,
			s.TargetURL,
		)
	}
	_ = tw.Flush()
	fmt.Println("\nPress Ctrl+C to stop and clean up.")
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// runAdd implements `callsign add <name=target>`.
func runAdd(args []string) error {
	fs := flag.NewFlagSet("add", flag.ContinueOnError)
	configPath := fs.String("config", config.DefaultConfigPath, "Path to callsign.yaml")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() < 1 {
		return errors.New("usage: callsign add <name=target>")
	}

	svc, err := config.ParseServicePair(fs.Arg(0))
	if err != nil {
		return err
	}

	// First try hot-reloading the live daemon via the local admin endpoint
	payload, _ := json.Marshal(map[string]string{
		"name":   svc.Name,
		"target": svc.TargetURL,
	})
	resp, err := http.Post("http://"+config.DefaultAdminAddr+"/api/services", "application/json", bytes.NewReader(payload))
	if err == nil {
		defer resp.Body.Close()
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			fmt.Printf("✓ Added and hot-reloaded %s -> %s (http://%s.local)\n", svc.Name, svc.TargetURL, svc.Name)
			return nil
		}
	}

	// Fallback: update callsign.yaml directly on disk
	store := config.NewStore(*configPath)
	if err := store.Load(); err != nil {
		return err
	}
	store.Upsert(svc)
	if err := store.Save(); err != nil {
		return err
	}
	fmt.Printf("✓ Saved %s -> %s to %s (daemon not running; start with `callsign serve`)\n", svc.Name, svc.TargetURL, store.Path())
	return nil
}

// runRemove implements `callsign rm <name>`.
func runRemove(args []string) error {
	fs := flag.NewFlagSet("rm", flag.ContinueOnError)
	configPath := fs.String("config", config.DefaultConfigPath, "Path to callsign.yaml")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() < 1 {
		return errors.New("usage: callsign rm <name>")
	}
	name := strings.ToLower(strings.TrimSpace(fs.Arg(0)))

	req, _ := http.NewRequest(http.MethodDelete, "http://"+config.DefaultAdminAddr+"/api/services/"+name, nil)
	if resp, err := http.DefaultClient.Do(req); err == nil {
		defer resp.Body.Close()
		if resp.StatusCode == http.StatusOK {
			fmt.Printf("✓ Removed %q from running daemon and config.\n", name)
			return nil
		}
	}

	store := config.NewStore(*configPath)
	if err := store.Load(); err != nil {
		return err
	}
	if !store.Remove(name) {
		return fmt.Errorf("service %q not found in %s", name, store.Path())
	}
	if err := store.Save(); err != nil {
		return err
	}
	fmt.Printf("✓ Removed %q from %s.\n", name, store.Path())
	return nil
}

// runList implements `callsign ls`.
func runList(args []string) error {
	fs := flag.NewFlagSet("ls", flag.ContinueOnError)
	configPath := fs.String("config", config.DefaultConfigPath, "Path to callsign.yaml")
	if err := fs.Parse(args); err != nil {
		return err
	}

	// Query running daemon first if active
	client := &http.Client{Timeout: 800 * time.Millisecond}
	if resp, err := client.Get("http://" + config.DefaultAdminAddr + "/api/status"); err == nil {
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		var data struct {
			Domain   string                    `json:"domain"`
			LanIP    string                    `json:"lanIp"`
			Services []dashboard.ServiceStatus `json:"services"`
		}
		if json.Unmarshal(body, &data) == nil {
			printServiceStatusTable(data.Domain, data.LanIP, data.Services, true)
			return nil
		}
	}

	store := config.NewStore(*configPath)
	if err := store.Load(); err != nil {
		return err
	}
	lanIP, _, err := netutil.PrimaryLANIPv4()
	ipStr := "127.0.0.1"
	if err == nil && lanIP != nil {
		ipStr = lanIP.String()
	}

	var rows []dashboard.ServiceStatus
	for _, s := range store.List() {
		probe := netutil.ProbeTCP(s.HostPort, 400*time.Millisecond)
		rows = append(rows, dashboard.ServiceStatus{
			Name:      s.Name,
			Target:    s.TargetURL,
			LocalURL:  fmt.Sprintf("http://%s.local", s.Name),
			DomainURL: fmt.Sprintf("http://%s.%s", s.Name, store.Domain()),
			Online:    probe.Online,
			LatencyMs: probe.LatencyMs,
		})
	}
	printServiceStatusTable(store.Domain(), ipStr, rows, false)
	return nil
}

func printServiceStatusTable(domain, lanIP string, services []dashboard.ServiceStatus, daemonLive bool) {
	stateLabel := "stopped (reading config)"
	if daemonLive {
		stateLabel = "running"
	}
	fmt.Printf("Callsign (%s) · LAN IP: %s · Domain: .%s\n\n", stateLabel, lanIP, domain)
	if len(services) == 0 {
		fmt.Println("No services configured. Add one with: callsign add plex=32400")
		return
	}

	tw := tabwriter.NewWriter(os.Stdout, 0, 0, 3, ' ', 0)
	fmt.Fprintln(tw, "NAME\t.LOCAL URL\tCUSTOM URL\tUPSTREAM\tSTATUS")
	fmt.Fprintln(tw, "────\t──────────\t──────────\t────────\t──────")
	for _, s := range services {
		status := "OFFLINE"
		if s.Online {
			status = fmt.Sprintf("ONLINE (%dms)", s.LatencyMs)
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\n", s.Name, s.LocalURL, s.DomainURL, s.Target, status)
	}
	_ = tw.Flush()
}

// runDoctor implements `callsign doctor`.
func runDoctor(args []string) error {
	fs := flag.NewFlagSet("doctor", flag.ContinueOnError)
	domain := fs.String("domain", "x", "Domain suffix to validate")
	if err := fs.Parse(args); err != nil {
		return err
	}

	fmt.Println("Callsign network diagnostics")
	fmt.Println("────────────────────────────")

	// 1. Primary LAN IPv4
	ip, iface, err := netutil.PrimaryLANIPv4()
	if err != nil {
		fmt.Printf("[FAIL] Primary LAN IPv4 : %v\n", err)
	} else {
		fmt.Printf("[PASS] Primary LAN IPv4 : %s (interface %s)\n", ip.String(), iface)
	}

	// 2. Container / WSL2 Isolation Check
	if isolated, reason := netutil.ContainerNotice(); isolated {
		fmt.Printf("[WARN] Network Isolation: %s\n", reason)
	} else {
		fmt.Println("[PASS] Network Mode     : Host L2 multicast reachable")
	}

	// 3. Multicast Interfaces
	ifaces, err := netutil.MulticastInterfaces()
	if err != nil || len(ifaces) == 0 {
		fmt.Println("[WARN] mDNS Interfaces  : No active non-loopback multicast interfaces found")
	} else {
		var names []string
		for _, i := range ifaces {
			names = append(names, i.Name)
		}
		fmt.Printf("[PASS] mDNS Interfaces  : %s\n", strings.Join(names, ", "))
	}

	// 4. Port checks (80, 53)
	if err := netutil.CheckPortAvailable("tcp4", "0.0.0.0:80"); err != nil {
		fmt.Printf("[WARN] TCP Port 80      : %v (use sudo or setcap cap_net_bind_service=+ep)\n", err)
	} else {
		fmt.Println("[PASS] TCP Port 80      : Available for HTTP/WebSocket Reverse Proxy")
	}

	bindDNSAddr := "0.0.0.0:53"
	if ip != nil {
		bindDNSAddr = fmt.Sprintf("%s:53", ip.String())
	}
	if err := netutil.CheckPortAvailable("udp4", bindDNSAddr); err != nil {
		fmt.Printf("[WARN] UDP Port 53      : %v (bound on %s)\n", err, bindDNSAddr)
	} else {
		fmt.Printf("[PASS] UDP Port 53      : Available on %s\n", bindDNSAddr)
	}

	// 5. Tailscale CGNAT Overlay Check
	if tsIP, tsIface := netutil.TailscaleIPv4(); tsIP != nil {
		fmt.Printf("[PASS] Tailscale Mesh   : %s (interface %s — Split-Horizon DNS ready)\n", tsIP.String(), tsIface)
	} else {
		fmt.Println("[INFO] Tailscale Mesh   : Not detected (optional — install Tailscale for global *.x access)")
	}

	// 6. TLD Safety Check
	res := tld.Validate(*domain, false)
	fmt.Printf("[%s] Domain .%-8s : %s — %s\n", res.Tier, res.Domain, res.Title, res.Message)

	return nil
}

// runMCP implements `callsign mcp` (Model Context Protocol JSON-RPC 2.0 server over stdio).
func runMCP(args []string) error {
	fs := flag.NewFlagSet("mcp", flag.ContinueOnError)
	configPath := fs.String("config", config.DefaultConfigPath, "Path to callsign.yaml")
	allowMutations := fs.Bool("allow-agent-mutations", false, "Allow AI agents to register or remove services")
	agentToken := fs.String("agent-token", "", "Optional Bearer token required for mutating agent tool calls")
	if err := fs.Parse(args); err != nil {
		return err
	}

	store := config.NewStore(*configPath)
	if err := store.Load(); err != nil {
		return err
	}

	lanIP, _, err := netutil.PrimaryLANIPv4()
	if err != nil || lanIP == nil {
		lanIP = net.ParseIP("127.0.0.1")
	}
	tsIP, _ := netutil.TailscaleIPv4()

	srv := mcp.NewServer(store, lanIP, tsIP, *allowMutations, *agentToken)
	return srv.ServeStdio(os.Stdin, os.Stdout)
}
