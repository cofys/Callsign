import React, { useState } from 'react';
import {
  validateTld,
  isTailscaleIp,
  resolveSplitHorizonIp,
} from '../utils/callsignCore';

interface SetupWizardViewProps {
  domain: string;
  lanIp: string;
  tailscaleIp: string;
  tailscaleEnabled: boolean;
  onSetDomain: (d: string) => void;
  onSetTailscaleIp: (ip: string) => void;
  onSetTailscaleEnabled: (enabled: boolean) => void;
  onOpenMobileConfig: () => void;
  onOpenAndroidModal: () => void;
}

const QUICK_DOMAINS = [
  { id: 'a', label: '.a', desc: '1-letter lightning fast' },
  { id: 'b', label: '.b', desc: 'Ultra-short 1-letter' },
  { id: 'c', label: '.c', desc: 'Minimalist 1-letter' },
  { id: 'x', label: '.x', desc: 'Clean default custom' },
  { id: 'hub', label: '.hub', desc: 'Central smart home & dev' },
  { id: 'lab', label: '.lab', desc: 'Homelab & self-hosting' },
];

export const SetupWizardView: React.FC<SetupWizardViewProps> = ({
  domain,
  lanIp,
  tailscaleIp,
  tailscaleEnabled,
  onSetDomain,
  onSetTailscaleIp,
  onSetTailscaleEnabled,
  onOpenMobileConfig,
  onOpenAndroidModal,
}) => {
  const [customInput, setCustomInput] = useState(domain);
  const [savedNotice, setSavedNotice] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [probeSourceIp, setProbeSourceIp] = useState('100.90.4.12');
  const [showAdvancedAcl, setShowAdvancedAcl] = useState(false);

  const cleanCandidate = customInput.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  const validation = validateTld(cleanCandidate || domain);
  const tsValid = isTailscaleIp(tailscaleIp);
  const horizonTest = resolveSplitHorizonIp(
    probeSourceIp,
    lanIp,
    tailscaleEnabled && tsValid ? tailscaleIp : undefined
  );

  const handleApplyDomain = (nextDomain: string) => {
    const normalized = nextDomain.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
    if (!normalized) return;
    const check = validateTld(normalized);
    if (check.blocked) return;
    setCustomInput(normalized);
    onSetDomain(normalized);
    setSavedNotice(true);
    setTimeout(() => setSavedNotice(false), 2000);
  };

  const handleCopy = (key: string, value: string) => {
    navigator.clipboard.writeText(value);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const tailscaleAclJson = JSON.stringify(
    {
      acls: [
        {
          action: 'accept',
          src: ['autogroup:member'],
          dst: [`${tailscaleIp}:53`, `${tailscaleIp}:80`],
        },
        {
          action: 'accept',
          src: ['tag:ai-agent'],
          dst: [`${tailscaleIp}:53`, `${tailscaleIp}:80`],
        },
      ],
    },
    null,
    2
  );

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      {/* Section 1: Pick Any Custom Extension */}
      <section className="rounded-2xl border border-slate-800 bg-[#111827] p-6 sm:p-8">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-white">
            01. Create Any Custom Extension You Want
          </h2>
          {savedNotice && (
            <span className="text-xs font-medium text-emerald-400">
              Saved .{domain}
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-slate-400">
          Every app automatically works at <code className="text-slate-200">.local</code> (like{' '}
          <code className="text-sky-400">http://app.local</code>). Callsign lets you invent <strong className="text-white">any custom extension</strong> you want (<code className="text-sky-400">.a</code>, <code className="text-sky-400">.b</code>, <code className="text-sky-400">.c</code>, <code className="text-sky-400">.x</code>, <code className="text-sky-400">.hub</code>, etc.).
        </p>

        {/* Feature Highlight Callout */}
        <div className="mt-4 rounded-xl border border-sky-500/20 bg-sky-500/5 p-3.5 text-xs text-sky-200">
          <div className="flex items-center gap-2 font-semibold text-sky-300">
            <span>✨ Infinite Custom Extensions</span>
            <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] text-sky-200">Not limited to presets</span>
          </div>
          <p className="mt-1 text-slate-300">
            You are not locked into any fixed list. Single-letter suffixes (<code className="text-white font-mono">.a</code>, <code className="text-white font-mono">.b</code>, <code className="text-white font-mono">.c</code>, <code className="text-white font-mono">.x</code>) and custom names work right away. As long as it is <strong className="text-white">NOT a real public extension</strong> (like <code className="text-amber-300 font-mono">.com</code> or <code className="text-amber-300 font-mono">.dev</code>), it resolves seamlessly across your LAN and Tailscale mesh.
          </p>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-6">
          {QUICK_DOMAINS.map((item) => {
            const active = domain === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleApplyDomain(item.id)}
                className={`rounded-xl border p-3 text-left transition-colors ${
                  active
                    ? 'border-sky-500 bg-sky-500/10 text-white'
                    : 'border-slate-800 bg-[#0b0f19] text-slate-300 hover:border-slate-700'
                }`}
              >
                <div className="font-mono text-sm font-bold text-white">
                  {item.label}
                </div>
                <div className="mt-0.5 text-[11px] text-slate-400 truncate">{item.desc}</div>
              </button>
            );
          })}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleApplyDomain(customInput);
          }}
          className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center"
        >
          <div className="relative flex-1">
            <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 font-mono text-sm text-slate-500">
              .
            </span>
            <input
              type="text"
              value={customInput}
              onChange={(e) => setCustomInput(e.target.value)}
              placeholder="Type any custom extension (e.g. a, b, c, z, hub, lab, mybox)"
              aria-label="Custom domain ending"
              className="w-full rounded-xl border border-slate-800 bg-[#0b0f19] py-2.5 pl-7 pr-3.5 font-mono text-sm text-white placeholder:font-sans placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
            />
          </div>
          <button
            type="submit"
            disabled={!cleanCandidate || validation.blocked}
            className="rounded-xl bg-sky-500 px-5 py-2.5 text-xs font-semibold text-slate-950 hover:bg-sky-400 disabled:opacity-40 whitespace-nowrap shrink-0"
          >
            Use .{cleanCandidate || domain}
          </button>
        </form>

        {validation.tier !== 'GREEN' ? (
          <p
            className={`mt-2.5 text-xs ${
              validation.tier === 'RED' ? 'text-red-400' : 'text-amber-300'
            }`}
          >
            {validation.message}
          </p>
        ) : (
          <p className="mt-2 text-xs text-emerald-400">
            ✓ .{cleanCandidate || domain} is a valid custom non-public extension. Safe for immediate use!
          </p>
        )}
      </section>

      {/* Section 2: Connect Your Devices on Home Wi-Fi */}
      <section className="rounded-2xl border border-slate-800 bg-[#111827] p-6 sm:p-8">
        <h2 className="text-lg font-semibold text-white">
          02. Connect Your Phones &amp; Computers on Home Wi-Fi
        </h2>
        <p className="mt-1 text-sm text-slate-400">
          Zero-configuration access while connected to your home network:
        </p>

        <div className="mt-5 divide-y divide-slate-800 rounded-xl border border-slate-800 bg-[#0b0f19]">
          <div className="flex flex-col justify-between gap-3 p-4 sm:flex-row sm:items-center">
            <div>
              <div className="text-sm font-semibold text-white">
                Mac, Windows &amp; Linux Computers
              </div>
              <p className="mt-0.5 text-xs text-slate-400">
                Works automatically via mDNS and <code className="text-slate-300">/etc/hosts</code>. Open <code className="text-sky-400">http://&lt;app&gt;.local</code> or <code className="text-sky-400">http://&lt;app&gt;.{domain}</code>.
              </p>
            </div>
            <span className="text-xs font-medium text-emerald-400 whitespace-nowrap shrink-0">
              Ready out of the box
            </span>
          </div>

          <div className="flex flex-col justify-between gap-3 p-4 sm:flex-row sm:items-center">
            <div>
              <div className="text-sm font-semibold text-white">
                iPhone &amp; iPad
              </div>
              <p className="mt-0.5 text-xs text-slate-400">
                <code className="text-sky-400">.local</code> works automatically. For <code className="text-sky-400">.{domain}</code> links, install the 1-click Split-DNS profile.
              </p>
            </div>
            <button
              type="button"
              onClick={onOpenMobileConfig}
              className="rounded-lg border border-slate-700 bg-[#111827] px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              Get iPhone Profile
            </button>
          </div>

          <div className="flex flex-col justify-between gap-3 p-4 sm:flex-row sm:items-center">
            <div>
              <div className="text-sm font-semibold text-white">
                Android Phones
              </div>
              <p className="mt-0.5 text-xs text-slate-400">
                Download the Universal Companion APK (with Evil-Twin Wi-Fi verification) or use Private DNS.
              </p>
            </div>
            <button
              type="button"
              onClick={onOpenAndroidModal}
              className="rounded-lg border border-slate-700 bg-[#111827] px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              Get Android App (APK)
            </button>
          </div>
        </div>
      </section>

      {/* Section 3: Tailscale Mesh Split-Horizon DNS */}
      <section className="rounded-2xl border border-slate-800 bg-[#111827] p-6 sm:p-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-white">
              03. Anywhere Access via Tailscale (Split-Horizon DNS)
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              Let any laptop, phone on 5G, or remote AI agent on your Tailscale network resolve{' '}
              <code className="text-sky-400">*.{domain}</code> with zero router port forwarding.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onSetTailscaleEnabled(!tailscaleEnabled)}
            className={`rounded-lg border px-3.5 py-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
              tailscaleEnabled
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                : 'border-slate-700 bg-[#0b0f19] text-slate-400 hover:text-white'
            }`}
          >
            {tailscaleEnabled ? 'Tailscale Listener: Enabled' : 'Enable Tailscale Listener'}
          </button>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-slate-800 bg-[#0b0f19] p-4">
            <label
              htmlFor="tailscale-ip-input"
              className="block text-xs font-medium text-slate-400"
            >
              Callsign Host Tailscale IPv4 (100.64.0.0/10)
            </label>
            <div className="mt-2 flex items-center gap-2">
              <input
                id="tailscale-ip-input"
                type="text"
                value={tailscaleIp}
                onChange={(e) => onSetTailscaleIp(e.target.value)}
                placeholder="100.85.12.34"
                className="w-full rounded-lg border border-slate-800 bg-[#111827] px-3 py-2 font-mono text-xs tabular-nums text-white focus:border-sky-500 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => handleCopy('ts-ip', tailscaleIp)}
                className="rounded-lg border border-slate-700 bg-[#111827] px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 whitespace-nowrap shrink-0"
              >
                {copiedKey === 'ts-ip' ? 'Copied' : 'Copy IP'}
              </button>
            </div>
            {!tsValid && (
              <p className="mt-1.5 text-xs text-amber-300">
                Enter a valid Tailscale CGNAT address in the 100.64.0.0/10 range (100.64.x.x – 100.127.x.x).
              </p>
            )}
          </div>

          <div className="rounded-xl border border-slate-800 bg-[#0b0f19] p-4">
            <div className="text-xs font-medium text-slate-400">
              One-Time Tailscale Admin Console Rule
            </div>
            <ol className="mt-2 space-y-1 text-xs text-slate-300">
              <li>
                1. Open <strong>Tailscale Admin &rarr; DNS &rarr; Nameservers</strong>
              </li>
              <li>
                2. Add Custom Nameserver: <code className="font-mono tabular-nums text-sky-400">{tailscaleIp}</code>
              </li>
              <li>
                3. Enable <strong>Restrict to domain</strong>: <code className="font-mono text-sky-400">{domain}</code>
              </li>
            </ol>
          </div>
        </div>

        {/* Interactive Split-Horizon DNS Resolver Tester */}
        <div className="mt-5 rounded-xl border border-slate-800 bg-[#0b0f19] p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-xs font-semibold text-white">
                Automatic Source-IP Split-Horizon Resolution
              </div>
              <p className="text-xs text-slate-400">
                Callsign inspects the requester&apos;s IP so home Wi-Fi traffic stays on direct Gigabit LAN while remote peers route over WireGuard—even for LAN devices that cannot run Tailscale.
              </p>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-xs text-slate-400">Simulate DNS query from:</span>
            {[
              { label: 'Home Wi-Fi (192.168.1.50)', ip: '192.168.1.50' },
              { label: 'Remote Tailscale Peer (100.90.4.12)', ip: '100.90.4.12' },
              { label: 'Public Internet (8.8.4.4)', ip: '8.8.4.4' },
            ].map((preset) => (
              <button
                key={preset.ip}
                type="button"
                onClick={() => setProbeSourceIp(preset.ip)}
                className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  probeSourceIp === preset.ip
                    ? 'border-sky-500 bg-sky-500/10 text-sky-300'
                    : 'border-slate-800 bg-[#111827] text-slate-400 hover:text-slate-200'
                }`}
              >
                {preset.label}
              </button>
            ))}
          </div>

          <div className="mt-3 flex flex-col justify-between gap-2 rounded-lg border border-slate-800/90 bg-[#111827] px-3.5 py-2.5 font-mono text-xs tabular-nums sm:flex-row sm:items-center">
            <span className="text-slate-300">
              Client <strong className="text-white">{probeSourceIp}</strong> queries{' '}
              <strong className="text-sky-400">app.{domain}</strong>
            </span>
            {horizonTest.horizon === 'BLOCKED' ? (
              <span className="text-red-400">
                REFUSED (Blocked by Private LAN + Tailscale CGNAT ACL)
              </span>
            ) : (
              <span className="text-emerald-400">
                A {horizonTest.answerIp} ({horizonTest.horizon} Horizon)
              </span>
            )}
          </div>
        </div>

        {/* Optional Advanced Tailscale ACL Snippet */}
        <div className="mt-4">
          <button
            type="button"
            onClick={() => setShowAdvancedAcl(!showAdvancedAcl)}
            aria-expanded={showAdvancedAcl}
            className="text-xs font-medium text-slate-400 hover:text-white transition-colors"
          >
            {showAdvancedAcl
              ? 'Hide Optional Tailscale ACL Policy (Zero-Trust Agent Scoping)'
              : 'Show Optional Tailscale ACL Policy (Zero-Trust Agent Scoping)'}
          </button>

          {showAdvancedAcl && (
            <div className="mt-3 rounded-xl border border-slate-800 bg-[#0b0f19] p-4">
              <div className="flex items-center justify-between pb-2">
                <span className="text-xs text-slate-400">
                  Restrict tagged cloud AI agents (<code className="text-slate-200">tag:ai-agent</code>) to only reach Callsign DNS (53) and HTTP Proxy (80):
                </span>
                <button
                  type="button"
                  onClick={() => handleCopy('ts-acl', tailscaleAclJson)}
                  className="rounded border border-slate-700 bg-[#111827] px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-slate-800 whitespace-nowrap shrink-0"
                >
                  {copiedKey === 'ts-acl' ? 'Copied' : 'Copy ACL JSON'}
                </button>
              </div>
              <pre className="overflow-x-auto font-mono text-xs tabular-nums text-sky-300 select-all">
                {tailscaleAclJson}
              </pre>
            </div>
          )}
        </div>
      </section>
    </div>
  );
};
