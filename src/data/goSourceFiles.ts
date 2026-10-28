import goModRaw from '../../go.mod?raw';
import mainGoRaw from '../../cmd/lanname/main.go?raw';
import configGoRaw from '../../internal/config/config.go?raw';
import netutilGoRaw from '../../internal/netutil/netutil.go?raw';
import validatorGoRaw from '../../internal/tld/validator.go?raw';
import responderGoRaw from '../../internal/mdns/responder.go?raw';
import sockoptUnixGoRaw from '../../internal/mdns/sockopt_unix.go?raw';
import sockoptWindowsGoRaw from '../../internal/mdns/sockopt_windows.go?raw';
import dnsServerGoRaw from '../../internal/dnsserver/server.go?raw';
import hostsGoRaw from '../../internal/hosts/hosts.go?raw';
import proxyGoRaw from '../../internal/proxy/proxy.go?raw';
import dashboardGoRaw from '../../internal/dashboard/dashboard.go?raw';
import androidManifestRaw from '../../android/AndroidManifest.xml?raw';
import androidMainActivityRaw from '../../android/MainActivity.kt?raw';
import androidVpnKtRaw from '../../android/LannameVpnService.kt?raw';
import androidGradleRaw from '../../android/build.gradle.kts?raw';
import androidWorkflowRaw from '../../.github/workflows/build-android-apk.yml?raw';
import readmeMdRaw from '../../README.md?raw';

export interface GoSourceFileEntry {
  path: string;
  packageName: string;
  summary: string;
  content: string;
}

export const GO_SOURCE_FILES: GoSourceFileEntry[] = [
  {
    path: 'go.mod',
    packageName: 'module',
    summary: 'Go 1.22 module definition with miekg/dns, golang.org/x/net, and gopkg.in/yaml.v3',
    content: goModRaw,
  },
  {
    path: 'cmd/lanname/main.go',
    packageName: 'main',
    summary: 'CLI parser, subcommands (serve, add, rm, ls, doctor), startup banner, and signal handling',
    content: mainGoRaw,
  },
  {
    path: 'internal/config/config.go',
    packageName: 'config',
    summary: 'Atomic YAML load/save, cryptographic InstanceID generator, CLI name=target parser, and thread-safe state store',
    content: configGoRaw,
  },
  {
    path: 'internal/netutil/netutil.go',
    packageName: 'netutil',
    summary: 'Primary LAN IPv4 routing probe, multicast interface discovery, Docker/WSL2 check, and TCP prober',
    content: netutilGoRaw,
  },
  {
    path: 'internal/tld/validator.go',
    packageName: 'tld',
    summary: '3-tier domain suffix safety classifier (Red HSTS preload block, Yellow ICANN warning, Green private)',
    content: validatorGoRaw,
  },
  {
    path: 'internal/mdns/responder.go',
    packageName: 'mdns',
    summary: 'Custom UDP 5353 multi-alias mDNS responder, A + immediate AAAA NODATA synthesis, gratuitous announcer',
    content: responderGoRaw,
  },
  {
    path: 'internal/mdns/sockopt_unix.go',
    packageName: 'mdns',
    summary: 'Linux/macOS/BSD build-tagged SO_REUSEADDR and SO_REUSEPORT socket control for Avahi/mDNSResponder coexistence',
    content: sockoptUnixGoRaw,
  },
  {
    path: 'internal/mdns/sockopt_windows.go',
    packageName: 'mdns',
    summary: 'Windows build-tagged SO_REUSEADDR multicast UDP socket option helper',
    content: sockoptWindowsGoRaw,
  },
  {
    path: 'internal/dnsserver/server.go',
    packageName: 'dnsserver',
    summary: 'Authoritative UDP/TCP 53 *.domain responder, Private LAN ACL, _lanname.<domain> TXT identity probe, and DoH canary blocker',
    content: dnsServerGoRaw,
  },
  {
    path: 'internal/hosts/hosts.go',
    packageName: 'hosts',
    summary: 'Cross-platform fenced # BEGIN LANNAME ... # END LANNAME manager for /etc/hosts',
    content: hostsGoRaw,
  },
  {
    path: 'internal/proxy/proxy.go',
    packageName: 'proxy',
    summary: 'HTTP/1.1 & WebSocket ReverseProxy router, X-Forwarded-* headers, and auto-retrying 502 error page',
    content: proxyGoRaw,
  },
  {
    path: 'internal/dashboard/dashboard.go',
    packageName: 'dashboard',
    summary: 'Live Web Hub, /api/identity, /setup/lanname-companion.apk, and iOS .mobileconfig builder',
    content: dashboardGoRaw,
  },
  {
    path: 'android/AndroidManifest.xml',
    packageName: 'companion-apk',
    summary: 'Universal Android APK manifest with VpnService binding and lanname://configure QR deep-link intent filter',
    content: androidManifestRaw,
  },
  {
    path: 'android/MainActivity.kt',
    packageName: 'companion-apk',
    summary: 'Minimalist 1-button Android Activity with QR deep-link auto-setup and bundled assets/lanname.json loader',
    content: androidMainActivityRaw,
  },
  {
    path: 'android/LannameVpnService.kt',
    packageName: 'companion-apk',
    summary: 'Android VpnService Split-DNS shim with Evil-Twin cryptographic identity verification and Wi-Fi NetworkCallback auto-teardown',
    content: androidVpnKtRaw,
  },
  {
    path: 'android/build.gradle.kts',
    packageName: 'companion-apk',
    summary: 'Gradle configuration producing a ~90KB architecture-independent Universal APK (ARM64, ARMv7, x86_64)',
    content: androidGradleRaw,
  },
  {
    path: '.github/workflows/build-android-apk.yml',
    packageName: 'ci-cd',
    summary: 'Automated GitHub Actions workflow to compile and sign lanname-companion-universal.apk in the cloud',
    content: androidWorkflowRaw,
  },
  {
    path: 'README.md',
    packageName: 'docs',
    summary: 'Quickstart, Linux setcap cap_net_bind_service one-liner, Docker --net=host usage, and FAQ',
    content: readmeMdRaw,
  },
];

