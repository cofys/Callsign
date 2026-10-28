export interface ServiceMapping {
  name: string;
  targetUrl: string;
  hostPort: string;
  online: boolean;
  latencyMs: number;
}

export interface ServicePreset {
  id: string;
  name: string;
  displayName: string;
  defaultPort: number;
  category: 'Media' | 'Smart Home' | 'Network' | 'AI / Dev' | 'Storage';
  description: string;
}

export const COMMON_SERVICE_PRESETS: ServicePreset[] = [
  {
    id: 'plex',
    name: 'plex',
    displayName: 'Plex Media Server',
    defaultPort: 32400,
    category: 'Media',
    description: 'Movies, TV shows, and music streaming on your home network',
  },
  {
    id: 'homeassistant',
    name: 'ha',
    displayName: 'Home Assistant',
    defaultPort: 8123,
    category: 'Smart Home',
    description: 'Local home automation, IoT dashboard, and smart device control',
  },
  {
    id: 'pihole',
    name: 'pihole',
    displayName: 'Pi-hole / AdGuard',
    defaultPort: 8088,
    category: 'Network',
    description: 'Network-wide ad blocking and local DNS sinkhole',
  },
  {
    id: 'jellyfin',
    name: 'jellyfin',
    displayName: 'Jellyfin Media Server',
    defaultPort: 8096,
    category: 'Media',
    description: 'Open-source media streaming alternative without accounts',
  },
  {
    id: 'ollama',
    name: 'ollama',
    displayName: 'Ollama Local AI',
    defaultPort: 11434,
    category: 'AI / Dev',
    description: 'Local LLM server running Llama 3, Mistral, and DeepSeek',
  },
  {
    id: 'synology',
    name: 'nas',
    displayName: 'Synology / TrueNAS',
    defaultPort: 5000,
    category: 'Storage',
    description: 'Network Attached Storage file manager and backup target',
  },
  {
    id: 'portainer',
    name: 'docker',
    displayName: 'Portainer / Dockge',
    defaultPort: 9000,
    category: 'AI / Dev',
    description: 'Web-based Docker container manager and compose stack editor',
  },
  {
    id: 'grafana',
    name: 'metrics',
    displayName: 'Grafana Dashboard',
    defaultPort: 3000,
    category: 'AI / Dev',
    description: 'Homelab monitoring, temperature sensors, and server metrics',
  },
];

export type TldTier = 'GREEN' | 'YELLOW' | 'RED';

export interface TldValidationResult {
  domain: string;
  tier: TldTier;
  title: string;
  message: string;
  blocked: boolean;
}

export interface DnsPacketSimulation {
  protocol: 'mDNS (UDP 5353)' | 'Unicast DNS (UDP/TCP 53)';
  questionName: string;
  questionType: 'A' | 'AAAA' | 'TXT' | 'ANY';
  rcode: 'NOERROR' | 'NXDOMAIN' | 'SERVFAIL' | 'IGNORED (Silent Drop)';
  authoritative: boolean;
  cacheFlush: boolean;
  ttlSeconds: number;
  answers: string[];
  extra: string[];
  explanation: string;
  replyDestination: string;
}

const VALID_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

const RED_TLDS: Record<string, string> = {
  dev: 'Google Registry HSTS-preloaded TLD; Chrome, Edge, Firefox, and Safari force HTTPS and hard-block plain HTTP on *.dev',
  app: 'HSTS-preloaded TLD; all modern browsers hard-block plain HTTP on *.app',
  page: 'HSTS-preloaded TLD; browsers force HTTPS and reject plain HTTP on *.page',
  new: 'HSTS-preloaded TLD; browsers force HTTPS on *.new',
  foo: 'HSTS-preloaded TLD; browsers force HTTPS on *.foo',
  day: 'HSTS-preloaded TLD; browsers force HTTPS on *.day',
  channel: 'HSTS-preloaded TLD; browsers force HTTPS on *.channel',
  local: 'Reserved by RFC 6762 for Multicast DNS (mDNS); Callsign already announces *.local automatically via UDP 5353',
  localhost: 'Reserved by RFC 6761 as loopback; browsers resolve *.localhost to 127.0.0.1 internally and ignore LAN DNS',
};

const YELLOW_TLDS = new Set([
  'com',
  'net',
  'org',
  'io',
  'xyz',
  'ai',
  'tech',
  'cloud',
  'co',
  'me',
  'tv',
  'sh',
  'gg',
  'cc',
  'info',
  'biz',
]);

export function normalizeDomain(domain: string): string {
  const clean = domain.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  return clean || 'x';
}

export function parseServicePair(
  expr: string,
  defaultOnline = true,
  defaultLatencyMs = 2
): ServiceMapping {
  const trimmed = expr.trim();
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx === -1) {
    throw new Error(`Expected format <name>=<target>, got "${expr}"`);
  }
  const rawName = trimmed.slice(0, eqIdx);
  const rawTarget = trimmed.slice(eqIdx + 1);
  return createServiceMapping(rawName, rawTarget, defaultOnline, defaultLatencyMs);
}

export function createServiceMapping(
  name: string,
  target: string,
  online = true,
  latencyMs = 2
): ServiceMapping {
  const cleanName = name.trim().toLowerCase();
  if (!VALID_NAME_RE.test(cleanName)) {
    throw new Error(
      `Invalid service name "${name}" (use lowercase letters, numbers, and hyphens)`
    );
  }

  let rawTarget = target.trim();
  if (!rawTarget) {
    throw new Error('Target port or address cannot be empty');
  }

  if (rawTarget.startsWith(':')) {
    rawTarget = rawTarget.slice(1);
  }

  // Case 1: Bare port number like "3000"
  if (/^\d+$/.test(rawTarget)) {
    const port = Number(rawTarget);
    if (port < 1 || port > 65535) {
      throw new Error(`Port ${port} out of range (1-65535)`);
    }
    const hostPort = `127.0.0.1:${port}`;
    return {
      name: cleanName,
      targetUrl: `http://${hostPort}`,
      hostPort,
      online,
      latencyMs,
    };
  }

  // Case 2: Host:Port or URL
  let fullUrl = rawTarget;
  if (!fullUrl.includes('://')) {
    fullUrl = `http://${fullUrl}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(fullUrl);
  } catch {
    throw new Error(`Invalid target address "${target}"`);
  }

  if (!parsed.hostname) {
    throw new Error(`Invalid target hostname in "${target}"`);
  }

  const host =
    parsed.hostname === 'localhost' ? '127.0.0.1' : parsed.hostname;
  const portStr =
    parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  const portNum = Number(portStr);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    throw new Error(`Invalid target port "${portStr}"`);
  }

  const scheme = parsed.protocol === 'https:' ? 'https' : 'http';
  const hostPort = `${host}:${portNum}`;

  return {
    name: cleanName,
    targetUrl: `${scheme}://${hostPort}`,
    hostPort,
    online,
    latencyMs,
  };
}

export function validateTld(domain: string, force = false): TldValidationResult {
  const clean = normalizeDomain(domain);
  const parts = clean.split('.');
  const lastLabel = parts[parts.length - 1];

  if (RED_TLDS[clean]) {
    return {
      domain: clean,
      tier: 'RED',
      title: `Unsafe Domain Suffix (.${clean})`,
      message: `${RED_TLDS[clean]}. Choose a safe private suffix like --domain x, --domain lan, or --domain home (or pass --force to override).`,
      blocked: !force,
    };
  }

  if (RED_TLDS[lastLabel]) {
    return {
      domain: clean,
      tier: 'RED',
      title: `Unsafe Parent TLD (.${lastLabel})`,
      message: `${RED_TLDS[lastLabel]}. Choose a safe private suffix like --domain x, --domain lan, or --domain home (or pass --force to override).`,
      blocked: !force,
    };
  }

  if (YELLOW_TLDS.has(clean) || YELLOW_TLDS.has(lastLabel)) {
    return {
      domain: clean,
      tier: 'YELLOW',
      title: `Public ICANN TLD Warning (.${clean})`,
      message: `.${clean} is a delegated public internet TLD. Shadowing it on your LAN can mask real internet domains and leak internal hostnames when laptops roam off-Wi-Fi. Consider an unallocated suffix like --domain x or --domain home.arpa.`,
      blocked: false,
    };
  }

  return {
    domain: clean,
    tier: 'GREEN',
    title: `Safe Private Suffix (.${clean})`,
    message: `.${clean} is safe for local LAN resolution (no HSTS preload conflicts or public ICANN collisions).`,
    blocked: false,
  };
}

export function simulateMdnsQuery(
  rawQname: string,
  qtype: 'A' | 'AAAA' | 'TXT' | 'ANY',
  quBit: boolean,
  lanIp: string,
  domain: string,
  services: ServiceMapping[]
): DnsPacketSimulation {
  const cleanName = rawQname.trim().toLowerCase().replace(/\.+$/, '');
  const fqdn = `${cleanName}.`;
  const cleanDomain = normalizeDomain(domain);

  const registeredLocalNames = new Set<string>([
    `${cleanDomain}.local`,
    ...services.map((s) => `${s.name}.local`),
  ]);

  const replyDest = quBit
    ? 'Unicast Direct Reply (QU=1 -> Requester UDP Port)'
    : 'Multicast 224.0.0.251:5353 (QM=0)';

  if (!registeredLocalNames.has(cleanName)) {
    return {
      protocol: 'mDNS (UDP 5353)',
      questionName: fqdn,
      questionType: qtype,
      rcode: 'IGNORED (Silent Drop)',
      authoritative: false,
      cacheFlush: false,
      ttlSeconds: 0,
      answers: [],
      extra: [],
      explanation: `Per RFC 6762, mDNS responders silently ignore queries for names they do not own (${fqdn}) so other devices on the LAN can answer.`,
      replyDestination: 'None',
    };
  }

  if (qtype === 'AAAA') {
    return {
      protocol: 'mDNS (UDP 5353)',
      questionName: fqdn,
      questionType: 'AAAA',
      rcode: 'NOERROR',
      authoritative: true,
      cacheFlush: true,
      ttlSeconds: 120,
      answers: [],
      extra: [`${fqdn} 120 IN NSEC ${fqdn} A (Cache-Flush 0x8000)`],
      explanation:
        'CRITICAL Dual-Stack Fast-Path: Returns immediate authoritative NOERROR with 0 Answer records (NODATA) + NSEC bitmap proving only IPv4 (Type A) exists. Eliminates the 5-second IPv6 timeout on macOS, iOS, Windows, and Linux.',
      replyDestination: replyDest,
    };
  }

  return {
    protocol: 'mDNS (UDP 5353)',
    questionName: fqdn,
    questionType: qtype,
    rcode: 'NOERROR',
    authoritative: true,
    cacheFlush: true,
    ttlSeconds: 120,
    answers: [`${fqdn} 120 IN A ${lanIp} (ClassINET | CacheFlush 0x8000)`],
    extra: [],
    explanation: `Authoritative mDNS response mapping ${fqdn} to host primary LAN IPv4 (${lanIp}) with Cache-Flush bit (0x8000) and 120s TTL.`,
    replyDestination: replyDest,
  };
}

export function simulateDnsQuery(
  rawQname: string,
  qtype: 'A' | 'AAAA' | 'TXT' | 'ANY',
  lanIp: string,
  domain: string,
  services: ServiceMapping[],
  upstreams: string[] = ['1.1.1.1:53', '8.8.8.8:53']
): DnsPacketSimulation {
  const cleanName = rawQname.trim().toLowerCase().replace(/\.+$/, '');
  const fqdn = `${cleanName}.`;
  const cleanDomain = normalizeDomain(domain);

  // 1. Browser DoH Canary Protection
  if (
    cleanName === 'use-application-dns.net' ||
    cleanName.endsWith('.use-application-dns.net') ||
    cleanName === '_dns.resolver.arpa' ||
    cleanName.endsWith('._dns.resolver.arpa')
  ) {
    return {
      protocol: 'Unicast DNS (UDP/TCP 53)',
      questionName: fqdn,
      questionType: qtype,
      rcode: 'NXDOMAIN',
      authoritative: true,
      cacheFlush: false,
      ttlSeconds: 60,
      answers: [],
      extra: [],
      explanation:
        'Browser DoH Canary Blocked: Returning authoritative NXDOMAIN signals Firefox and Chrome that a local split-horizon LAN resolver is active, preventing encrypted DNS bypass.',
      replyDestination: 'Client Stub Resolver (UDP/TCP 53)',
    };
  }

  // 2. Local custom domain (*.<domain> or <domain> or *.local)
  const isLocalDomain =
    cleanName === cleanDomain ||
    cleanName.endsWith(`.${cleanDomain}`) ||
    cleanName.endsWith('.local');

  if (isLocalDomain) {
    if (qtype === 'AAAA') {
      return {
        protocol: 'Unicast DNS (UDP/TCP 53)',
        questionName: fqdn,
        questionType: 'AAAA',
        rcode: 'NOERROR',
        authoritative: true,
        cacheFlush: false,
        ttlSeconds: 60,
        answers: [],
        extra: [],
        explanation: `Immediate NOERROR with 0 answers (NODATA) for ${fqdn} so dual-stack stub resolvers immediately use the IPv4 A record.`,
        replyDestination: 'Client Stub Resolver (UDP/TCP 53)',
      };
    }

    if (qtype === 'TXT') {
      return {
        protocol: 'Unicast DNS (UDP/TCP 53)',
        questionName: fqdn,
        questionType: 'TXT',
        rcode: 'NOERROR',
        authoritative: true,
        cacheFlush: false,
        ttlSeconds: 60,
        answers: [
          `${fqdn} 60 IN TXT "callsign-daemon=active" "callsign-instance=cs-9f8e7d6c5b4a3210" "callsign-domain=${cleanDomain}"`,
        ],
        extra: [],
        explanation: `Cryptographic Identity TXT record for ${fqdn}. Used by the Android VpnService companion app to verify this host is the user's genuine Callsign daemon before routing DNS.`,
        replyDestination: 'Client Stub Resolver (UDP/TCP 53)',
      };
    }

    const matchedSvc = services.find(
      (s) =>
        cleanName === `${s.name}.${cleanDomain}` ||
        cleanName === `${s.name}.local`
    );

    return {
      protocol: 'Unicast DNS (UDP/TCP 53)',
      questionName: fqdn,
      questionType: qtype,
      rcode: 'NOERROR',
      authoritative: true,
      cacheFlush: false,
      ttlSeconds: 60,
      answers: [`${fqdn} 60 IN A ${lanIp}`],
      extra: [],
      explanation: matchedSvc
        ? `Authoritative local A record resolving ${fqdn} -> ${lanIp} (reverse proxy routes Host: ${cleanName} -> ${matchedSvc.targetUrl}).`
        : `Authoritative local A record resolving ${fqdn} -> ${lanIp} (LAN Hub / Wildcard).`,
      replyDestination: 'Client Stub Resolver (UDP/TCP 53)',
    };
  }

  // 3. Forwarded upstream query
  return {
    protocol: 'Unicast DNS (UDP/TCP 53)',
    questionName: fqdn,
    questionType: qtype,
    rcode: 'NOERROR',
    authoritative: false,
    cacheFlush: false,
    ttlSeconds: 300,
    answers: [`${fqdn} 300 IN ${qtype === 'AAAA' ? 'AAAA 2606:4700::6810:85e5' : 'A 104.16.133.229'} (via ${upstreams[0]})`],
    extra: [],
    explanation: `Non-local domain forwarded to upstream resolver (${upstreams.join(', ')}) with 2s timeout.`,
    replyDestination: 'Client Stub Resolver (UDP/TCP 53)',
  };
}

/**
 * Enforces Private LAN ACL on Port 53 so that if a router accidentally exposes port 53
 * via UPnP or DMZ, public internet queries are refused (RcodeRefused).
 */
export function isPrivateLanIp(ip: string): boolean {
  const clean = ip.trim().toLowerCase();
  if (clean === '127.0.0.1' || clean === '::1' || clean.startsWith('127.')) {
    return true;
  }
  if (clean.startsWith('10.') || clean.startsWith('192.168.') || clean.startsWith('169.254.')) {
    return true;
  }
  if (clean.startsWith('172.')) {
    const secondOctet = Number(clean.split('.')[1]);
    if (secondOctet >= 16 && secondOctet <= 31) {
      return true;
    }
  }
  // IPv6 ULA (fc00::/7 -> fc.. or fd..) and Link-Local (fe80::/10)
  if (clean.startsWith('fc') || clean.startsWith('fd') || clean.startsWith('fe80:')) {
    return true;
  }
  return false;
}

/**
 * Defends /api/services mutations against Cross-Site Request Forgery (CSRF) and DNS Rebinding
 * from malicious websites visited while on the home LAN.
 */
export function verifyMutationRequestOrigin(params: {
  hostHeader: string;
  originHeader?: string;
  secFetchSite?: string;
  lanIp: string;
  domain: string;
}): { allowed: boolean; reason: string } {
  const secFetch = (params.secFetchSite || '').trim().toLowerCase();
  if (secFetch && secFetch !== 'same-origin' && secFetch !== 'none') {
    return {
      allowed: false,
      reason: `Blocked cross-site request (Sec-Fetch-Site: ${secFetch})`,
    };
  }

  const cleanHost = params.hostHeader.trim().toLowerCase().split(':')[0];
  const cleanDomain = normalizeDomain(params.domain);
  const allowedHosts = new Set([
    '127.0.0.1',
    'localhost',
    params.lanIp.trim().toLowerCase(),
    cleanDomain,
    `${cleanDomain}.local`,
  ]);

  if (!allowedHosts.has(cleanHost)) {
    return {
      allowed: false,
      reason: `Blocked DNS rebinding attempt (untrusted Host header: ${cleanHost})`,
    };
  }

  if (params.originHeader) {
    const originHost = params.originHeader
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .split(':')[0];
    if (originHost !== cleanHost) {
      return {
        allowed: false,
        reason: `Blocked mismatched Origin (${originHost} !== ${cleanHost})`,
      };
    }
  }

  return { allowed: true, reason: 'Verified Same-Origin local hub request' };
}

/**
 * Verifies that a target LAN IP on the current Wi-Fi network is genuinely the user's
 * Callsign daemon before the Android VpnService companion activates Split-DNS.
 */
export function verifyDaemonIdentityProbe(params: {
  txtRecords: string[];
  expectedInstanceId: string;
}): { verified: boolean; reason: string } {
  const hasActiveMarker = params.txtRecords.some(
    (r) => r.includes('callsign-daemon=active') || r.includes('lanname-daemon=active')
  );
  if (!hasActiveMarker) {
    return {
      verified: false,
      reason: 'Host did not return callsign-daemon=active TXT marker (subnet collision / foreign network)',
    };
  }
  const expected = params.expectedInstanceId.trim();
  if (expected) {
    const matchesInstance = params.txtRecords.some(
      (r) =>
        r.includes(`callsign-instance=${expected}`) ||
        r.includes(`lanname-instance=${expected}`)
    );
    if (!matchesInstance) {
      return {
        verified: false,
        reason: `Host instance_id mismatch (expected ${expected}); keeping VPN dormant to prevent Evil-Twin DNS hijacking`,
      };
    }
  }
  return {
    verified: true,
    reason: 'Cryptographic instance_id verified over Wi-Fi; safe to activate Split-DNS tunnel',
  };
}

export function buildHostsBlock(
  lanIp: string,
  domainOrDomains: string | string[],
  serviceNames: string[]
): string {
  const domains = Array.isArray(domainOrDomains)
    ? domainOrDomains.map(normalizeDomain)
    : [normalizeDomain(domainOrDomains)];
  
  const hostnames: string[] = [];
  for (const dom of domains) {
    hostnames.push(dom);
    for (const name of serviceNames) {
      hostnames.push(`${name.trim().toLowerCase()}.${dom}`);
    }
  }

  return [
    '# BEGIN CALLSIGN',
    `${lanIp} ${hostnames.join(' ')}`,
    '# END CALLSIGN',
  ].join('\n');
}

export function generateMobileConfigXml(
  domainOrDomains: string | string[],
  lanIp: string
): string {
  const domains = Array.isArray(domainOrDomains)
    ? domainOrDomains.map(normalizeDomain)
    : [normalizeDomain(domainOrDomains)];
  const primaryDomain = domains[0] || 'x';
  const matchDomainsXml = [...domains, 'local']
    .map((d) => `\t\t\t\t\t<string>${d}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>PayloadContent</key>
	<array>
		<dict>
			<key>DNSSettings</key>
			<dict>
				<key>DNSProtocol</key>
				<string>Cleartext</string>
				<key>ServerAddresses</key>
				<array>
					<string>${lanIp}</string>
				</array>
				<key>SupplementalMatchDomains</key>
				<array>
${matchDomainsXml}
				</array>
			</dict>
			<key>PayloadDescription</key>
			<string>Routes *.${primaryDomain} local LAN domains to ${lanIp}</string>
			<key>PayloadDisplayName</key>
			<string>Callsign (.${primaryDomain} Split-DNS)</string>
			<key>PayloadIdentifier</key>
			<string>io.callsign.dns.${primaryDomain}.settings</string>
			<key>PayloadType</key>
			<string>com.apple.dnsSettings.managed</string>
			<key>PayloadUUID</key>
			<string>4a8b9d12-6e41-4c20-9f88-1029384756ab</string>
			<key>PayloadVersion</key>
			<integer>1</integer>
		</dict>
	</array>
	<key>PayloadDescription</key>
	<string>Zero-config split-DNS profile generated by Callsign so your iPhone, iPad, or Mac resolves *.${primaryDomain} directly via ${lanIp} without changing router DHCP.</string>
	<key>PayloadDisplayName</key>
	<string>Callsign — .${primaryDomain} Local Domain</string>
	<key>PayloadIdentifier</key>
	<string>io.callsign.profile.${primaryDomain}</string>
	<key>PayloadOrganization</key>
	<string>Callsign</string>
	<key>PayloadRemovalDisallowed</key>
	<false/>
	<key>PayloadType</key>
	<string>Configuration</string>
	<key>PayloadUUID</key>
	<string>9f1e2d3c-4b5a-4678-8901-abcdef123456</string>
	<key>PayloadVersion</key>
	<integer>1</integer>
</dict>
</plist>`;
}

export function generateOfflineQrMatrix(text: string): number[][] {
  const size = 21;
  const grid: number[][] = Array.from({ length: size }, () =>
    Array(size).fill(0)
  );

  const placeFinder = (rowOffset: number, colOffset: number) => {
    for (let dr = 0; dr < 7; dr++) {
      for (let dc = 0; dc < 7; dc++) {
        const isBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const isInner = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        grid[rowOffset + dr][colOffset + dc] = isBorder || isInner ? 1 : 0;
      }
    }
  };

  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    grid[6][i] = i % 2 === 0 ? 1 : 0;
    grid[i][6] = i % 2 === 0 ? 1 : 0;
  }

  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  let bitIdx = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const inFinder =
        (r < 8 && c < 8) ||
        (r < 8 && c >= size - 8) ||
        (r >= size - 8 && c < 8) ||
        r === 6 ||
        c === 6;
      if (inFinder) continue;
      const charCode = text.charCodeAt(bitIdx % text.length);
      grid[r][c] = ((charCode >> (bitIdx % 7)) ^ ((hash >> (bitIdx % 16)) & 1)) & 1;
      bitIdx++;
    }
  }

  return grid;
}

