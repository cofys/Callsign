package netutil

import (
	"fmt"
	"net"
	"os"
	"runtime"
	"strings"
	"time"
)

// LANInterface describes a discovered network interface and its primary IPv4 address.
type LANInterface struct {
	Name string
	IP   net.IP
}

// PrimaryLANIPv4 discovers the host's primary non-loopback LAN IPv4 address.
// It prefers the kernel routing table via a UDP dial probe (which sends no packets)
// and falls back to scanning active multicast-capable interfaces.
func PrimaryLANIPv4() (net.IP, string, error) {
	conn, err := net.DialTimeout("udp4", "1.1.1.1:80", 500*time.Millisecond)
	if err == nil {
		defer conn.Close()
		if udpAddr, ok := conn.LocalAddr().(*net.UDPAddr); ok {
			if ip4 := udpAddr.IP.To4(); ip4 != nil && !ip4.IsLoopback() {
				ifaceName := interfaceNameForIP(ip4)
				return ip4, ifaceName, nil
			}
		}
	}

	ifaces, err := MulticastInterfaces()
	if err == nil && len(ifaces) > 0 {
		for _, iface := range ifaces {
			addrs, err := iface.Addrs()
			if err != nil {
				continue
			}
			for _, addr := range addrs {
				ip := extractIPv4(addr)
				if ip != nil && isPrivateLANIPv4(ip) {
					return ip, iface.Name, nil
				}
			}
		}
		for _, iface := range ifaces {
			addrs, err := iface.Addrs()
			if err != nil {
				continue
			}
			for _, addr := range addrs {
				if ip := extractIPv4(addr); ip != nil {
					return ip, iface.Name, nil
				}
			}
		}
	}

	return nil, "", fmt.Errorf("could not determine primary non-loopback LAN IPv4 address")
}

// MulticastInterfaces returns all active, non-loopback, multicast-capable network interfaces
// that have at least one IPv4 address and are not virtual container bridges.
func MulticastInterfaces() ([]net.Interface, error) {
	all, err := net.Interfaces()
	if err != nil {
		return nil, err
	}

	var result []net.Interface
	for _, iface := range all {
		if iface.Flags&net.FlagUp == 0 {
			continue
		}
		if iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		if iface.Flags&net.FlagMulticast == 0 {
			continue
		}
		if isVirtualBridgeName(iface.Name) {
			continue
		}

		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		hasIPv4 := false
		for _, a := range addrs {
			if extractIPv4(a) != nil {
				hasIPv4 = true
				break
			}
		}
		if hasIPv4 {
			result = append(result, iface)
		}
	}
	return result, nil
}

func interfaceNameForIP(target net.IP) string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return "unknown"
	}
	for _, iface := range ifaces {
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			if ip := extractIPv4(addr); ip != nil && ip.Equal(target) {
				return iface.Name
			}
		}
	}
	return "default"
}

func extractIPv4(addr net.Addr) net.IP {
	var ip net.IP
	switch v := addr.(type) {
	case *net.IPNet:
		ip = v.IP
	case *net.IPAddr:
		ip = v.IP
	}
	if ip == nil {
		return nil
	}
	ip4 := ip.To4()
	if ip4 == nil || ip4.IsLoopback() || ip4.IsLinkLocalUnicast() {
		return nil
	}
	return ip4
}

func isPrivateLANIPv4(ip net.IP) bool {
	ip4 := ip.To4()
	if ip4 == nil {
		return false
	}
	switch {
	case ip4[0] == 10:
		return true
	case ip4[0] == 172 && ip4[1] >= 16 && ip4[1] <= 31:
		return true
	case ip4[0] == 192 && ip4[1] == 168:
		return true
	default:
		return false
	}
}

func isVirtualBridgeName(name string) bool {
	lower := strings.ToLower(name)
	prefixes := []string{"docker", "br-", "veth", "virbr", "cni", "flannel", "cali", "tun", "tap"}
	for _, p := range prefixes {
		if strings.HasPrefix(lower, p) {
			return true
		}
	}
	return false
}

// ContainerNotice inspects the runtime environment for Docker bridge mode or WSL2 NAT
// where mDNS multicast traffic (224.0.0.251:5353) cannot reach physical Wi-Fi devices.
func ContainerNotice() (inIsolatedNet bool, reason string) {
	if _, err := os.Stat("/.dockerenv"); err == nil {
		// In Docker: check if only eth0 on 172.17.x.x is present vs host networking
		ip, iface, err := PrimaryLANIPv4()
		if err == nil && ip != nil && ip.To4()[0] == 172 && ip.To4()[1] == 17 {
			return true, fmt.Sprintf("Running inside Docker bridge network (%s: %s). Run Docker with --net=host so mDNS multicast reaches your Wi-Fi LAN.", iface, ip.String())
		}
	}

	if runtime.GOOS == "linux" {
		if data, err := os.ReadFile("/proc/version"); err == nil {
			lower := strings.ToLower(string(data))
			if strings.Contains(lower, "microsoft") || strings.Contains(lower, "wsl") {
				return true, "Running inside WSL2 NAT. Enable mirrored networkingMode in .wslconfig so Wi-Fi devices can reach mDNS and Port 80."
			}
		}
	}
	return false, ""
}

// ProbeResult captures the live health state of an upstream TCP/HTTP target.
type ProbeResult struct {
	Online    bool   `json:"online"`
	LatencyMs int64  `json:"latency_ms"`
	Error     string `json:"error,omitempty"`
}

// ProbeTCP performs a fast TCP handshake check against hostPort (e.g., "127.0.0.1:3100").
func ProbeTCP(hostPort string, timeout time.Duration) ProbeResult {
	if timeout <= 0 {
		timeout = 600 * time.Millisecond
	}
	start := time.Now()
	conn, err := net.DialTimeout("tcp", hostPort, timeout)
	elapsed := time.Since(start).Milliseconds()
	if err != nil {
		return ProbeResult{
			Online:    false,
			LatencyMs: elapsed,
			Error:     friendlyDialError(err),
		}
	}
	_ = conn.Close()
	if elapsed == 0 {
		elapsed = 1
	}
	return ProbeResult{
		Online:    true,
		LatencyMs: elapsed,
	}
}

func friendlyDialError(err error) string {
	if err == nil {
		return ""
	}
	msg := err.Error()
	switch {
	case strings.Contains(msg, "connection refused"):
		return "Connection refused — is the upstream service running?"
	case strings.Contains(msg, "i/o timeout"):
		return "Connection timed out — host unreachable or firewall blocked"
	case strings.Contains(msg, "no route to host"):
		return "No route to host — check LAN IP address"
	default:
		return msg
	}
}

// CheckPortAvailable tests whether a TCP or UDP port can be bound on the given IP.
func CheckPortAvailable(network, addr string) error {
	switch network {
	case "tcp", "tcp4":
		ln, err := net.Listen(network, addr)
		if err != nil {
			return err
		}
		_ = ln.Close()
		return nil
	case "udp", "udp4":
		pc, err := net.ListenPacket(network, addr)
		if err != nil {
			return err
		}
		_ = pc.Close()
		return nil
	default:
		return fmt.Errorf("unsupported network %q", network)
	}
}
