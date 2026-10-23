package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"

	"gopkg.in/yaml.v3"
)

const (
	DefaultConfigPath = "lanname.yaml"
	DefaultDomain     = "lan"
	DefaultHTTPPort   = 80
	DefaultDNSPort    = 53
	DefaultAdminAddr  = "127.0.0.1:43199"
)

var validNameRe = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

// Service represents a single named LAN service and its upstream target.
type Service struct {
	Name      string `yaml:"name" json:"name"`
	TargetURL string `yaml:"target" json:"target"`
	HostPort  string `yaml:"-" json:"hostPort"`
}

// FileConfig is the on-disk YAML representation of lanname.yaml.
type FileConfig struct {
	Domain    string            `yaml:"domain" json:"domain"`
	HTTPPort  int               `yaml:"http_port" json:"http_port"`
	DNSPort   int               `yaml:"dns_port" json:"dns_port"`
	NoDNS     bool              `yaml:"no_dns,omitempty" json:"no_dns,omitempty"`
	NoHosts   bool              `yaml:"no_hosts,omitempty" json:"no_hosts,omitempty"`
	Upstreams []string          `yaml:"upstreams,omitempty" json:"upstreams,omitempty"`
	Services  map[string]string `yaml:"services" json:"services"`
}

// Store holds the thread-safe runtime configuration and active service mappings.
type Store struct {
	mu        sync.RWMutex
	path      string
	domain    string
	httpPort  int
	dnsPort   int
	noDNS     bool
	noHosts   bool
	upstreams []string
	services  map[string]Service
	onChange  []func()
}

// NewStore creates a new thread-safe configuration store backed by path.
func NewStore(path string) *Store {
	if strings.TrimSpace(path) == "" {
		path = DefaultConfigPath
	}
	return &Store{
		path:      path,
		domain:    DefaultDomain,
		httpPort:  DefaultHTTPPort,
		dnsPort:   DefaultDNSPort,
		upstreams: []string{"1.1.1.1:53", "8.8.8.8:53"},
		services:  make(map[string]Service),
	}
}

// OnChange registers a callback invoked whenever services or domain settings change.
func (s *Store) OnChange(fn func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.onChange = append(s.onChange, fn)
}

func (s *Store) notify() {
	s.mu.RLock()
	callbacks := append([]func(){}, s.onChange...)
	s.mu.RUnlock()
	for _, fn := range callbacks {
		fn()
	}
}

// Load reads the YAML configuration from disk if it exists.
func (s *Store) Load() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := os.ReadFile(s.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("read config %s: %w", s.path, err)
	}

	var fc FileConfig
	if err := yaml.Unmarshal(data, &fc); err != nil {
		return fmt.Errorf("parse yaml %s: %w", s.path, err)
	}

	if fc.Domain != "" {
		s.domain = NormalizeDomain(fc.Domain)
	}
	if fc.HTTPPort > 0 {
		s.httpPort = fc.HTTPPort
	}
	if fc.DNSPort > 0 {
		s.dnsPort = fc.DNSPort
	}
	s.noDNS = fc.NoDNS
	s.noHosts = fc.NoHosts
	if len(fc.Upstreams) > 0 {
		s.upstreams = fc.Upstreams
	}

	for rawName, rawTarget := range fc.Services {
		svc, err := ParseServicePair(rawName + "=" + rawTarget)
		if err != nil {
			return fmt.Errorf("invalid service %q in %s: %w", rawName, s.path, err)
		}
		s.services[svc.Name] = svc
	}
	return nil
}

// Save atomically persists the current configuration to lanname.yaml.
func (s *Store) Save() error {
	s.mu.RLock()
	fc := FileConfig{
		Domain:    s.domain,
		HTTPPort:  s.httpPort,
		DNSPort:   s.dnsPort,
		NoDNS:     s.noDNS,
		NoHosts:   s.noHosts,
		Upstreams: append([]string{}, s.upstreams...),
		Services:  make(map[string]string, len(s.services)),
	}
	for k, v := range s.services {
		fc.Services[k] = v.TargetURL
	}
	path := s.path
	s.mu.RUnlock()

	out, err := yaml.Marshal(&fc)
	if err != nil {
		return fmt.Errorf("marshal config: %w", err)
	}

	dir := filepath.Dir(path)
	if dir != "." && dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("mkdir %s: %w", dir, err)
		}
	}

	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, out, 0o644); err != nil {
		return fmt.Errorf("write temp config: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("rename temp config: %w", err)
	}
	return nil
}

// SetRuntimeFlags overrides runtime settings from CLI flags.
func (s *Store) SetRuntimeFlags(domain string, httpPort, dnsPort int, noDNS, noHosts bool) {
	s.mu.Lock()
	if domain != "" {
		s.domain = NormalizeDomain(domain)
	}
	if httpPort > 0 {
		s.httpPort = httpPort
	}
	if dnsPort > 0 {
		s.dnsPort = dnsPort
	}
	s.noDNS = noDNS
	s.noHosts = noHosts
	s.mu.Unlock()
}

// Upsert adds or updates a service mapping and notifies listeners.
func (s *Store) Upsert(svc Service) {
	s.mu.Lock()
	s.services[svc.Name] = svc
	s.mu.Unlock()
	s.notify()
}

// Remove deletes a service by name and returns true if it existed.
func (s *Store) Remove(name string) bool {
	clean := strings.ToLower(strings.TrimSpace(name))
	s.mu.Lock()
	_, ok := s.services[clean]
	if ok {
		delete(s.services, clean)
	}
	s.mu.Unlock()
	if ok {
		s.notify()
	}
	return ok
}

// Get finds a service by name.
func (s *Store) Get(name string) (Service, bool) {
	clean := strings.ToLower(strings.TrimSpace(name))
	s.mu.RLock()
	defer s.mu.RUnlock()
	svc, ok := s.services[clean]
	return svc, ok
}

// List returns all registered services sorted alphabetically by name.
func (s *Store) List() []Service {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Service, 0, len(s.services))
	for _, svc := range s.services {
		out = append(out, svc)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].Name < out[j].Name
	})
	return out
}

// Domain returns the configured local domain suffix (without leading/trailing dots).
func (s *Store) Domain() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.domain
}

// HTTPPort returns the configured HTTP reverse proxy port.
func (s *Store) HTTPPort() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.httpPort
}

// DNSPort returns the configured DNS server port.
func (s *Store) DNSPort() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.dnsPort
}

// NoDNS returns true if the authoritative DNS server is disabled.
func (s *Store) NoDNS() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.noDNS
}

// NoHosts returns true if /etc/hosts synchronization is disabled.
func (s *Store) NoHosts() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.noHosts
}

// Upstreams returns the configured upstream DNS resolvers.
func (s *Store) Upstreams() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append([]string{}, s.upstreams...)
}

// Path returns the file path of the configuration file.
func (s *Store) Path() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.path
}

// NormalizeDomain strips leading/trailing dots and lowercases a TLD/suffix.
func NormalizeDomain(d string) string {
	d = strings.ToLower(strings.TrimSpace(d))
	d = strings.Trim(d, ".")
	if d == "" {
		return DefaultDomain
	}
	return d
}

// ParseServicePair parses a CLI or API mapping like "hq=3100", "nas=192.168.1.50:8080", or "app=http://10.0.0.5:9000".
func ParseServicePair(expr string) (Service, error) {
	parts := strings.SplitN(strings.TrimSpace(expr), "=", 2)
	if len(parts) != 2 {
		return Service{}, fmt.Errorf("expected format <name>=<target>, got %q", expr)
	}
	return NewService(parts[0], parts[1])
}

// NewService validates name and normalizes target into a full HTTP/HTTPS URL and host:port.
func NewService(name, target string) (Service, error) {
	cleanName := strings.ToLower(strings.TrimSpace(name))
	if !validNameRe.MatchString(cleanName) {
		return Service{}, fmt.Errorf("invalid service name %q (use lowercase alphanumeric and hyphens)", name)
	}

	rawTarget := strings.TrimSpace(target)
	if rawTarget == "" {
		return Service{}, errors.New("target cannot be empty")
	}

	// Case 1: Bare port number like "3100" -> "http://127.0.0.1:3100"
	if port, err := strconv.Atoi(rawTarget); err == nil {
		if port < 1 || port > 65535 {
			return Service{}, fmt.Errorf("port %d out of range (1-65535)", port)
		}
		hostPort := fmt.Sprintf("127.0.0.1:%d", port)
		return Service{
			Name:      cleanName,
			TargetURL: "http://" + hostPort,
			HostPort:  hostPort,
		}, nil
	}

	// Case 2: ":3100" shorthand
	if strings.HasPrefix(rawTarget, ":") {
		port, err := strconv.Atoi(strings.TrimPrefix(rawTarget, ":"))
		if err != nil || port < 1 || port > 65535 {
			return Service{}, fmt.Errorf("invalid port shorthand %q", rawTarget)
		}
		hostPort := fmt.Sprintf("127.0.0.1:%d", port)
		return Service{
			Name:      cleanName,
			TargetURL: "http://" + hostPort,
			HostPort:  hostPort,
		}, nil
	}

	// Case 3: Full URL or host:port
	fullURL := rawTarget
	if !strings.Contains(fullURL, "://") {
		fullURL = "http://" + fullURL
	}

	parsed, err := url.Parse(fullURL)
	if err != nil || parsed.Host == "" {
		return Service{}, fmt.Errorf("invalid target URL %q", target)
	}

	host, portStr, err := net.SplitHostPort(parsed.Host)
	if err != nil {
		// No explicit port provided; default based on scheme
		host = parsed.Host
		if parsed.Scheme == "https" {
			portStr = "443"
		} else {
			portStr = "80"
		}
	}
	if host == "" || host == "localhost" {
		host = "127.0.0.1"
	}
	portNum, err := strconv.Atoi(portStr)
	if err != nil || portNum < 1 || portNum > 65535 {
		return Service{}, fmt.Errorf("invalid target port %q", portStr)
	}

	hostPort := net.JoinHostPort(host, strconv.Itoa(portNum))
	normalizedURL := fmt.Sprintf("%s://%s", parsed.Scheme, hostPort)

	return Service{
		Name:      cleanName,
		TargetURL: normalizedURL,
		HostPort:  hostPort,
	}, nil
}
