import React, { useState } from 'react';
import {
  ServiceMapping,
  validateTld,
  simulateMdnsQuery,
  simulateDnsQuery,
} from '../utils/callsignCore';

interface ProtocolSimulatorViewProps {
  domain: string;
  lanIp: string;
  services: ServiceMapping[];
  onDomainChange: (nextDomain: string) => void;
  onAddServicePair: (expr: string) => void;
  onRemoveService: (name: string) => void;
}

export const ProtocolSimulatorView: React.FC<ProtocolSimulatorViewProps> = ({
  domain,
  lanIp,
  services,
  onDomainChange,
  onAddServicePair,
  onRemoveService,
}) => {
  // 1. TLD Validator State
  const [tldInput, setTldInput] = useState(domain);
  const [forceRedTld, setForceRedTld] = useState(false);

  // 2. Packet Inspector State
  const [protocolMode, setProtocolMode] = useState<'mdns' | 'dns'>('mdns');
  const [queryName, setQueryName] = useState(`${domain}.local`);
  const [queryType, setQueryType] = useState<'A' | 'AAAA' | 'TXT' | 'ANY'>('AAAA');
  const [quBit, setQuBit] = useState(false);

  // 3. CLI Runner State
  const [cliInput, setCliInput] = useState('callsign doctor --domain ' + domain);
  const [cliOutput, setCliOutput] = useState<string>(() =>
    buildDoctorOutput(domain, lanIp)
  );

  const tldResult = validateTld(tldInput, forceRedTld);

  const packetResult =
    protocolMode === 'mdns'
      ? simulateMdnsQuery(queryName, queryType, quBit, lanIp, domain, services)
      : simulateDnsQuery(queryName, queryType, lanIp, domain, services);

  const handleApplyDomain = () => {
    const res = validateTld(tldInput, forceRedTld);
    if (!res.blocked) {
      onDomainChange(res.domain);
    }
  };

  const handleRunCli = (e: React.FormEvent) => {
    e.preventDefault();
    const raw = cliInput.trim();
    const tokens = raw.split(/\s+/);
    const isBinaryPrefix =
      tokens[0] === 'callsign' || tokens[0] === 'lanname';
    const cmd = isBinaryPrefix ? tokens[1] || 'help' : tokens[0];

    if (cmd === 'ls' || cmd === 'list' || cmd === 'status') {
      const header = `Callsign (running) · LAN IP: ${lanIp} · Domain: .${domain}\n\nNAME       .LOCAL URL             CUSTOM URL             UPSTREAM                 STATUS\n────       ──────────             ──────────             ────────                 ──────`;
      if (services.length === 0) {
        setCliOutput(`${header}\n(no services configured — run "callsign add plex=32400")`);
        return;
      }
      const rows = services.map((s) => {
        const st = s.online ? `ONLINE (${s.latencyMs}ms)` : 'OFFLINE';
        return `${s.name.padEnd(10)} http://${(s.name + '.local').padEnd(15)} http://${(s.name + '.' + domain).padEnd(15)} ${s.targetUrl.padEnd(24)} ${st}`;
      });
      setCliOutput([header, ...rows].join('\n'));
      return;
    }

    if (cmd === 'add') {
      const pair = tokens[isBinaryPrefix ? 2 : 1];
      if (!pair) {
        setCliOutput('Error: usage: callsign add <name=target>');
        return;
      }
      try {
        onAddServicePair(pair);
        const namePart = pair.split('=')[0].trim().toLowerCase();
        setCliOutput(
          `✓ Added and hot-reloaded ${pair} (http://${namePart}.local & http://${namePart}.${domain})`
        );
      } catch (err) {
        setCliOutput(`Error: ${(err as Error).message}`);
      }
      return;
    }

    if (cmd === 'rm' || cmd === 'remove') {
      const targetName = tokens[isBinaryPrefix ? 2 : 1];
      if (!targetName) {
        setCliOutput('Error: usage: callsign rm <name>');
        return;
      }
      onRemoveService(targetName);
      setCliOutput(`✓ Removed "${targetName}" from running daemon and callsign.yaml.`);
      return;
    }

    if (cmd === 'doctor') {
      const domIdx = tokens.indexOf('--domain');
      const checkDom = domIdx !== -1 && tokens[domIdx + 1] ? tokens[domIdx + 1] : domain;
      setCliOutput(buildDoctorOutput(checkDom, lanIp));
      return;
    }

    if (cmd === 'serve') {
      const pairs = tokens.filter((t) => t.includes('=') && !t.startsWith('-'));
      pairs.forEach((p) => {
        try {
          onAddServicePair(p);
        } catch {
          // ignore invalid pair in banner preview
        }
      });
      const domIdx = tokens.indexOf('--domain');
      const nextDom = domIdx !== -1 && tokens[domIdx + 1] ? tokens[domIdx + 1] : domain;
      const check = validateTld(nextDom, tokens.includes('--force'));
      if (check.blocked) {
        setCliOutput(`Error: [TLD SAFETY BLOCK] ${check.title}: ${check.message}`);
        return;
      }
      onDomainChange(check.domain);
      setCliOutput(
        `╭──────────────────────────────────────────────────────────────────────────╮\n` +
          `│  Callsign daemon online · LAN IP: ${lanIp.padEnd(14)} (en0)                   │\n` +
          `╰──────────────────────────────────────────────────────────────────────────╯\n` +
          `  Dashboard Hub   : http://${check.domain}.local  |  http://${check.domain}\n` +
          `  mDNS Responder  : UDP 224.0.0.251:5353 (A + immediate AAAA NODATA)\n` +
          `  Local DNS       : ${lanIp}:53 (*.${check.domain} + DoH Canary NXDOMAIN)\n` +
          `  iOS DNS Profile : http://${check.domain}.local/setup/ios.mobileconfig`
      );
      return;
    }

    setCliOutput(
      `Callsign — Zero-Config LAN Naming & Reverse Proxy Daemon\n\nCommands:\n  callsign serve plex=32400 --domain ${domain}\n  callsign add <name=target>\n  callsign rm <name>\n  callsign ls\n  callsign doctor --domain ${domain}`
    );
  };

  return (
    <div className="space-y-8">
      {/* Section 1: mDNS (UDP 5353) & Unicast DNS (Port 53) Wire Packet Simulator */}
      <section className="rounded-xl border border-slate-800 bg-[#111827] p-6">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-800 pb-5">
          <div>
            <h2 className="text-xl font-bold text-slate-100">
              01. Live mDNS (RFC 6762) &amp; Unicast DNS (RFC 1035) Packet Simulator
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              Inspect how <code className="text-slate-200">internal/mdns</code> and{' '}
              <code className="text-slate-200">internal/dnsserver</code> synthesize wire responses,
              handle IPv6 dual-stack <code className="text-sky-400">AAAA</code> queries without 5-second stalls, and block browser DoH canary domains.
            </p>
          </div>

          <div className="flex items-center gap-1 rounded-lg bg-[#0b0f19] p-1 border border-slate-800">
            <button
              type="button"
              onClick={() => {
                setProtocolMode('mdns');
                setQueryName(`${domain}.local`);
                setQueryType('AAAA');
              }}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                protocolMode === 'mdns'
                  ? 'bg-sky-500 text-slate-950'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              mDNS Responder (UDP 5353)
            </button>
            <button
              type="button"
              onClick={() => {
                setProtocolMode('dns');
                setQueryName('use-application-dns.net');
                setQueryType('A');
              }}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                protocolMode === 'dns'
                  ? 'bg-sky-500 text-slate-950'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Authoritative DNS + Forwarder (Port 53)
            </button>
          </div>
        </div>

        {/* Preset Query Scenarios */}
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-slate-400 mr-1">
            Quick Test Scenarios:
          </span>
          <button
            type="button"
            onClick={() => {
              setProtocolMode('mdns');
              setQueryName(`${domain}.local`);
              setQueryType('AAAA');
              setQuBit(false);
            }}
            className="rounded-lg border border-slate-700 bg-[#0b0f19] px-3 py-1.5 text-xs font-mono text-slate-300 hover:border-sky-500/50 hover:text-sky-300 whitespace-nowrap shrink-0"
          >
            mDNS AAAA {domain}.local (Dual-Stack Fix)
          </button>
          <button
            type="button"
            onClick={() => {
              setProtocolMode('mdns');
              setQueryName(`${domain}.local`);
              setQueryType('A');
              setQuBit(true);
            }}
            className="rounded-lg border border-slate-700 bg-[#0b0f19] px-3 py-1.5 text-xs font-mono text-slate-300 hover:border-sky-500/50 hover:text-sky-300 whitespace-nowrap shrink-0"
          >
            mDNS A {domain}.local (QU=1 Unicast)
          </button>
          <button
            type="button"
            onClick={() => {
              setProtocolMode('dns');
              setQueryName('use-application-dns.net');
              setQueryType('A');
            }}
            className="rounded-lg border border-slate-700 bg-[#0b0f19] px-3 py-1.5 text-xs font-mono text-slate-300 hover:border-sky-500/50 hover:text-sky-300 whitespace-nowrap shrink-0"
          >
            DoH Canary (use-application-dns.net)
          </button>
          <button
            type="button"
            onClick={() => {
              setProtocolMode('dns');
              setQueryName(`app.${domain}`);
              setQueryType('A');
            }}
            className="rounded-lg border border-slate-700 bg-[#0b0f19] px-3 py-1.5 text-xs font-mono text-slate-300 hover:border-sky-500/50 hover:text-sky-300 whitespace-nowrap shrink-0"
          >
            DNS A app.{domain}
          </button>
          <button
            type="button"
            onClick={() => {
              setProtocolMode('dns');
              setQueryName('github.com');
              setQueryType('A');
            }}
            className="rounded-lg border border-slate-700 bg-[#0b0f19] px-3 py-1.5 text-xs font-mono text-slate-300 hover:border-sky-500/50 hover:text-sky-300 whitespace-nowrap shrink-0"
          >
            Upstream Forward (github.com)
          </button>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-6 lg:grid-cols-12">
          {/* Controls Column */}
          <div className="space-y-4 lg:col-span-5">
            <div>
              <label
                htmlFor="sim-qname"
                className="block text-xs font-medium text-slate-400 mb-1.5"
              >
                Question Domain Name (QNAME)
              </label>
              <input
                id="sim-qname"
                type="text"
                value={queryName}
                onChange={(e) => setQueryName(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-[#0b0f19] px-3.5 py-2 font-mono text-sm text-slate-100 focus:border-sky-400 focus:outline-none"
                placeholder={`${domain}.local`}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="sim-qtype"
                  className="block text-xs font-medium text-slate-400 mb-1.5"
                >
                  Record Type (QTYPE)
                </label>
                <select
                  id="sim-qtype"
                  value={queryType}
                  onChange={(e) =>
                    setQueryType(e.target.value as 'A' | 'AAAA' | 'TXT' | 'ANY')
                  }
                  className="w-full rounded-lg border border-slate-700 bg-[#0b0f19] px-3 py-2 font-mono text-sm text-slate-100 focus:border-sky-400 focus:outline-none"
                >
                  <option value="A">TypeA (IPv4)</option>
                  <option value="AAAA">TypeAAAA (IPv6)</option>
                  <option value="TXT">TypeTXT</option>
                  <option value="ANY">TypeANY</option>
                </select>
              </div>

              {protocolMode === 'mdns' && (
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1.5">
                    Unicast-Response Bit (QU)
                  </label>
                  <button
                    type="button"
                    onClick={() => setQuBit((v) => !v)}
                    className="w-full rounded-lg border border-slate-700 bg-[#0b0f19] px-3 py-2 font-mono text-xs text-slate-200 hover:border-slate-600 text-left whitespace-nowrap shrink-0"
                  >
                    {quBit ? 'QU=1 (Direct Unicast)' : 'QM=0 (224.0.0.251)'}
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Wire Response Output */}
          <div className="rounded-lg border border-slate-800 bg-[#0b0f19] p-5 font-mono text-xs lg:col-span-7">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3 text-slate-400">
              <span>{packetResult.protocol}</span>
              <span>
                RCODE:{' '}
                <strong
                  className={
                    packetResult.rcode === 'NOERROR'
                      ? 'text-emerald-400'
                      : packetResult.rcode === 'NXDOMAIN'
                      ? 'text-amber-400'
                      : 'text-slate-300'
                  }
                >
                  {packetResult.rcode}
                </strong>{' '}
                · AA: {packetResult.authoritative ? 'true' : 'false'} · Reply:{' '}
                {packetResult.replyDestination}
              </span>
            </div>

            <div className="mt-3 space-y-2 text-slate-300">
              <div>
                <span className="text-slate-500">QUESTION SECTION:</span>
                <div className="pl-3 text-sky-300">
                  {packetResult.questionName} IN {packetResult.questionType}
                </div>
              </div>

              <div>
                <span className="text-slate-500">ANSWER SECTION:</span>
                {packetResult.answers.length === 0 ? (
                  <div className="pl-3 text-slate-400">
                    (0 Answer Records — Immediate NODATA / Negative Response)
                  </div>
                ) : (
                  packetResult.answers.map((ans, idx) => (
                    <div key={idx} className="pl-3 text-emerald-300">
                      {ans}
                    </div>
                  ))
                )}
              </div>

              {packetResult.extra.length > 0 && (
                <div>
                  <span className="text-slate-500">ADDITIONAL / NSEC SECTION:</span>
                  {packetResult.extra.map((ex, idx) => (
                    <div key={idx} className="pl-3 text-amber-300">
                      {ex}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <p className="mt-4 border-t border-slate-800 pt-3 font-sans text-xs leading-relaxed text-slate-400">
              {packetResult.explanation}
            </p>
          </div>
        </div>
      </section>

      {/* Section 2: 3-Tier Domain Suffix Safety Validator & Interactive CLI Runner */}
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-12 items-stretch">
        {/* Domain Suffix Validator */}
        <section className="rounded-xl border border-slate-800 bg-[#111827] p-6 lg:col-span-5 flex flex-col justify-between">
          <div>
            <h2 className="text-xl font-bold text-slate-100">
              02. TLD Safety Classifier (internal/tld)
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              Validates <code className="text-slate-200">--domain</code> against HSTS-preloaded browser lists and public ICANN gTLDs.
            </p>

            <div className="mt-4 flex flex-wrap gap-2">
              {['x', 'home.arpa', 'dev', 'app', 'localhost', 'com', 'io'].map(
                (sample) => (
                  <button
                    key={sample}
                    type="button"
                    onClick={() => setTldInput(sample)}
                    className="rounded-md border border-slate-700 bg-[#0b0f19] px-2.5 py-1 font-mono text-xs text-slate-300 hover:border-sky-500/50 hover:text-sky-300 whitespace-nowrap shrink-0"
                  >
                    --domain {sample}
                  </button>
                )
              )}
            </div>

            <div className="mt-4 flex items-center gap-2">
              <label htmlFor="tld-input" className="sr-only">
                Domain Suffix
              </label>
              <input
                id="tld-input"
                type="text"
                value={tldInput}
                onChange={(e) => setTldInput(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-[#0b0f19] px-3.5 py-2 font-mono text-sm text-slate-100 focus:border-sky-400 focus:outline-none"
                placeholder="x"
              />
              <button
                type="button"
                onClick={handleApplyDomain}
                disabled={tldResult.blocked}
                className="rounded-lg bg-sky-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-sky-400 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
              >
                Apply Suffix
              </button>
            </div>

            <div className="mt-3 flex items-center gap-2">
              <input
                id="force-red-tld"
                type="checkbox"
                checked={forceRedTld}
                onChange={(e) => setForceRedTld(e.target.checked)}
                className="h-4 w-4 rounded border-slate-700 bg-slate-900"
              />
              <label htmlFor="force-red-tld" className="text-xs text-slate-400">
                Pass <code className="text-slate-200">--force</code> flag (override Red HSTS block)
              </label>
            </div>
          </div>

          <div className="mt-5 rounded-lg border border-slate-800 bg-[#0b0f19] p-4">
            <div className="flex items-center justify-between text-xs font-semibold">
              <span
                className={
                  tldResult.tier === 'GREEN'
                    ? 'text-emerald-400'
                    : tldResult.tier === 'YELLOW'
                    ? 'text-amber-400'
                    : 'text-red-400'
                }
              >
                Tier: {tldResult.tier} · {tldResult.title}
              </span>
              <span className="font-mono text-slate-400">
                {tldResult.blocked ? 'Hard Blocked' : 'Allowed'}
              </span>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-slate-300">
              {tldResult.message}
            </p>
          </div>
        </section>

        {/* Interactive CLI Sandbox */}
        <section className="rounded-xl border border-slate-800 bg-[#111827] p-6 lg:col-span-7 flex flex-col justify-between">
          <div>
            <h2 className="text-xl font-bold text-slate-100">
              03. Interactive CLI Terminal (Callsign)
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              Test <code className="text-slate-200">serve</code>,{' '}
              <code className="text-slate-200">add</code>,{' '}
              <code className="text-slate-200">rm</code>,{' '}
              <code className="text-slate-200">ls</code>, and{' '}
              <code className="text-slate-200">doctor</code> against the live state store.
            </p>

            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setCliInput(`callsign ls`)}
                className="rounded-md border border-slate-700 bg-[#0b0f19] px-2.5 py-1 font-mono text-xs text-slate-300 hover:text-sky-300 whitespace-nowrap shrink-0"
              >
                callsign ls
              </button>
              <button
                type="button"
                onClick={() => setCliInput(`callsign doctor --domain ${domain}`)}
                className="rounded-md border border-slate-700 bg-[#0b0f19] px-2.5 py-1 font-mono text-xs text-slate-300 hover:text-sky-300 whitespace-nowrap shrink-0"
              >
                callsign doctor
              </button>
              <button
                type="button"
                onClick={() => setCliInput(`callsign add grafana=3000`)}
                className="rounded-md border border-slate-700 bg-[#0b0f19] px-2.5 py-1 font-mono text-xs text-slate-300 hover:text-sky-300 whitespace-nowrap shrink-0"
              >
                callsign add grafana=3000
              </button>
              <button
                type="button"
                onClick={() =>
                  setCliInput(
                    `callsign serve plex=32400 ha=8123 --domain x`
                  )
                }
                className="rounded-md border border-slate-700 bg-[#0b0f19] px-2.5 py-1 font-mono text-xs text-slate-300 hover:text-sky-300 whitespace-nowrap shrink-0"
              >
                callsign serve ...
              </button>
            </div>

            <form onSubmit={handleRunCli} className="mt-4 flex gap-2">
              <label htmlFor="cli-command-input" className="sr-only">
                CLI Command
              </label>
              <input
                id="cli-command-input"
                type="text"
                value={cliInput}
                onChange={(e) => setCliInput(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-[#0b0f19] px-3.5 py-2 font-mono text-sm text-slate-100 focus:border-sky-400 focus:outline-none"
              />
              <button
                type="submit"
                className="rounded-lg bg-sky-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-sky-400 transition-colors whitespace-nowrap shrink-0"
              >
                Run Command
              </button>
            </form>
          </div>

          <pre className="mt-4 overflow-x-auto rounded-lg border border-slate-800 bg-[#0b0f19] p-4 font-mono text-xs leading-relaxed text-slate-200">
            {cliOutput}
          </pre>
        </section>
      </div>
    </div>
  );
};

function buildDoctorOutput(domain: string, lanIp: string): string {
  const res = validateTld(domain, false);
  return [
    'Callsign network diagnostics',
    '────────────────────────────',
    `[PASS] Primary LAN IPv4 : ${lanIp} (interface en0)`,
    '[PASS] Network Mode     : Host L2 multicast reachable',
    '[PASS] mDNS Interfaces  : en0 (UDP 224.0.0.251:5353 SO_REUSEADDR | SO_REUSEPORT)',
    '[PASS] TCP Port 80      : Available for HTTP/WebSocket Reverse Proxy',
    `[PASS] UDP Port 53      : Available on ${lanIp}:53`,
    `[${res.tier}] Domain .${res.domain.padEnd(8)} : ${res.title} — ${res.message}`,
  ].join('\n');
}
