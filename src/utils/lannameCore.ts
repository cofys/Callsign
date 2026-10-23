export interface ServiceMapping {
  name: string;
  targetUrl: string;
  hostPort: string;
  online: boolean;
  latencyMs: number;
}

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
  local: 'Reserved by RFC 6762 for Multicast DNS (mDNS); lanname already announces *.local automatically via UDP 5353',
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
  return clean || 'cofy';
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

  // Case 1: Bare port number like "3100"
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
      message: `${RED_TLDS[clean]}. Choose a safe private suffix like --domain cofy, --domain lan, or --domain home (or pass --force to override).`,
      blocked: !force,
    };
  }

  if (RED_TLDS[lastLabel]) {
    return {
      domain: clean,
      tier: 'RED',
      title: `Unsafe Parent TLD (.${lastLabel})`,
      message: `${RED_TLDS[lastLabel]}. Choose a safe private suffix like --domain cofy, --domain lan, or --domain home (or pass --force to override).`,
      blocked: !force,
    };
  }

  if (YELLOW_TLDS.has(clean) || YELLOW_TLDS.has(lastLabel)) {
    return {
      domain: clean,
      tier: 'YELLOW',
      title: `Public ICANN TLD Warning (.${clean})`,
      message: `.${clean} is a delegated public internet TLD. Shadowing it on your LAN can mask real internet domains and leak internal hostnames when laptops roam off-Wi-Fi. Consider an unallocated suffix like --domain cofy or --domain home.arpa.`,
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
        answers: [`${fqdn} 60 IN TXT "lanname-daemon=active"`],
        extra: [],
        explanation: `Authoritative local TXT record for ${fqdn}.`,
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

export function buildHostsBlock(
  lanIp: string,
  domain: string,
  serviceNames: string[]
): string {
  const cleanDomain = normalizeDomain(domain);
  const hostnames = [
    cleanDomain,
    ...serviceNames.map((n) => `${n.trim().toLowerCase()}.${cleanDomain}`),
  ];
  return [
    '# BEGIN LANNAME',
    `${lanIp} ${hostnames.join(' ')}`,
    '# END LANNAME',
  ].join('\n');
}

export function generateMobileConfigXml(domain: string, lanIp: string): string {
  const cleanDomain = normalizeDomain(domain);
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
					<string>${cleanDomain}</string>
					<string>local</string>
				</array>
			</dict>
			<key>PayloadDescription</key>
			<string>Routes *.${cleanDomain} local LAN domains to ${lanIp}</string>
			<key>PayloadDisplayName</key>
			<string>lanname (.${cleanDomain} Split-DNS)</string>
			<key>PayloadIdentifier</key>
			<string>io.lanname.dns.${cleanDomain}.settings</string>
			<key>PayloadType</key>
			<string>com.apple.dnsSettings.managed</string>
			<key>PayloadUUID</key>
			<string>4a8b9d12-6e41-4c20-9f88-1029384756ab</string>
			<key>PayloadVersion</key>
			<integer>1</integer>
		</dict>
	</array>
	<key>PayloadDescription</key>
	<string>Zero-config split-DNS profile generated by lanname so your iPhone, iPad, or Mac resolves *.${cleanDomain} directly via ${lanIp} without changing router DHCP.</string>
	<key>PayloadDisplayName</key>
	<string>lanname — .${cleanDomain} Local Domain</string>
	<key>PayloadIdentifier</key>
	<string>io.lanname.profile.${cleanDomain}</string>
	<key>PayloadOrganization</key>
	<string>lanname Homelab</string>
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
