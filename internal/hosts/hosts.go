package hosts

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

const (
	beginMarker = "# BEGIN CALLSIGN"
	endMarker   = "# END CALLSIGN"
)

// Manager safely synchronizes a fenced block in the OS hosts file (/etc/hosts)
// so that http://<service>.<domain>/ resolves immediately on the host machine itself.
type Manager struct {
	mu   sync.Mutex
	path string
}

// NewManager creates a Manager targeting the platform's system hosts file.
func NewManager() *Manager {
	return &Manager{
		path: DefaultHostsPath(),
	}
}

// DefaultHostsPath returns the standard OS path for the local hosts file.
func DefaultHostsPath() string {
	if runtime.GOOS == "windows" {
		sysRoot := os.Getenv("SystemRoot")
		if sysRoot == "" {
			sysRoot = `C:\Windows`
		}
		return filepath.Join(sysRoot, "System32", "drivers", "etc", "hosts")
	}
	return "/etc/hosts"
}

// Path returns the configured hosts file path.
func (m *Manager) Path() string {
	return m.path
}

// Sync writes or updates the fenced # BEGIN LANNAME ... # END LANNAME block in /etc/hosts.
func (m *Manager) Sync(lanIP net.IP, domain string, serviceNames []string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	content, err := os.ReadFile(m.path)
	if err != nil {
		return fmt.Errorf("read %s: %w", m.path, err)
	}

	cleaned := stripFencedBlock(string(content))
	block := BuildFencedBlock(lanIP.String(), domain, serviceNames)

	var updated string
	if strings.HasSuffix(cleaned, "\n") || cleaned == "" {
		updated = cleaned + block + "\n"
	} else {
		updated = cleaned + "\n" + block + "\n"
	}

	if err := os.WriteFile(m.path, []byte(updated), 0o644); err != nil {
		return fmt.Errorf("update %s (permission denied or read-only): %w", m.path, err)
	}
	return nil
}

// Cleanup removes the # BEGIN LANNAME ... # END LANNAME block from /etc/hosts on shutdown.
func (m *Manager) Cleanup() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	content, err := os.ReadFile(m.path)
	if err != nil {
		return err
	}

	cleaned := stripFencedBlock(string(content))
	return os.WriteFile(m.path, []byte(cleaned), 0o644)
}

// BuildFencedBlock formats the deterministic fenced hosts block for the given IP, domain, and services.
func BuildFencedBlock(ipStr, domain string, serviceNames []string) string {
	var hostnames []string
	cleanDomain := strings.Trim(strings.ToLower(strings.TrimSpace(domain)), ".")
	if cleanDomain != "" {
		hostnames = append(hostnames, cleanDomain)
		for _, svc := range serviceNames {
			cleanSvc := strings.ToLower(strings.TrimSpace(svc))
			if cleanSvc != "" {
				hostnames = append(hostnames, fmt.Sprintf("%s.%s", cleanSvc, cleanDomain))
			}
		}
	}

	var b strings.Builder
	b.WriteString(beginMarker + "\n")
	if len(hostnames) > 0 {
		b.WriteString(fmt.Sprintf("%s %s\n", ipStr, strings.Join(hostnames, " ")))
	}
	b.WriteString(endMarker)
	return b.String()
}

func stripFencedBlock(raw string) string {
	lines := strings.Split(raw, "\n")
	var out []string
	inBlock := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == beginMarker {
			inBlock = true
			continue
		}
		if trimmed == endMarker {
			inBlock = false
			continue
		}
		if !inBlock {
			out = append(out, line)
		}
	}
	return strings.Join(out, "\n")
}
