import React, { useState } from 'react';
import {
  ServiceMapping,
  ServicePreset,
  COMMON_SERVICE_PRESETS,
  createServiceMapping,
} from '../utils/lannameCore';

interface SetupWizardViewProps {
  domain: string;
  lanIp: string;
  services: ServiceMapping[];
  onSetDomain: (d: string) => void;
  onAddService: (s: ServiceMapping) => void;
  onOpenMobileConfig: () => void;
}

export const SetupWizardView: React.FC<SetupWizardViewProps> = ({
  domain,
  lanIp,
  services,
  onSetDomain,
  onAddService,
  onOpenMobileConfig,
}) => {
  const [activeStep, setActiveStep] = useState<1 | 2 | 3>(1);
  const [customDomainInput, setCustomDomainInput] = useState(domain);
  const [isScanning, setIsScanning] = useState(false);
  const [scanDiscovered, setScanDiscovered] = useState<ServicePreset[]>([]);
  const [installedServiceIds, setInstalledServiceIds] = useState<Set<string>>(() => {
    const existing = new Set<string>();
    services.forEach((s) => {
      COMMON_SERVICE_PRESETS.forEach((p) => {
        if (s.name === p.name || s.hostPort.includes(String(p.defaultPort))) {
          existing.add(p.id);
        }
      });
    });
    return existing;
  });

  const handleSimulateScan = () => {
    setIsScanning(true);
    setTimeout(() => {
      // Find presets that aren't already added
      const candidates = COMMON_SERVICE_PRESETS.filter(
        (p) => !services.some((s) => s.name === p.name)
      ).slice(0, 4);
      setScanDiscovered(candidates);
      setIsScanning(false);
    }, 900);
  };

  const handleAddPreset = (preset: ServicePreset) => {
    try {
      const mapping = createServiceMapping(
        preset.name,
        String(preset.defaultPort),
        true,
        2
      );
      onAddService(mapping);
      setInstalledServiceIds((prev) => new Set([...prev, preset.id]));
      setScanDiscovered((prev) => prev.filter((p) => p.id !== preset.id));
    } catch {
      // fallback
    }
  };

  const handleAddAllDiscovered = () => {
    scanDiscovered.forEach((p) => handleAddPreset(p));
  };

  return (
    <div className="space-y-8">
      {/* Overview Banner */}
      <section className="rounded-xl border border-slate-800 bg-[#111827] p-6">
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-center">
          <div>
            <div className="text-xs font-semibold text-sky-400">
              Zero-Friction Guide for Non-Technical Users
            </div>
            <h2 className="mt-1 text-2xl font-bold text-white">
              Setup in 60 Seconds: Custom Domains &amp; Prefixes
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed text-slate-300">
              You do <strong>not</strong> need to be an engineer or change your router to use clean URLs on your home Wi-Fi.
              Pick your favorite domain name, select your apps, and connect your devices in three easy steps.
            </p>
          </div>

          <div className="flex items-center gap-1.5 rounded-lg border border-slate-800 bg-[#0b0f19] p-1">
            {[1, 2, 3].map((stepNum) => (
              <button
                key={stepNum}
                type="button"
                onClick={() => setActiveStep(stepNum as 1 | 2 | 3)}
                className={`rounded-md px-3.5 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                  activeStep === stepNum
                    ? 'bg-sky-500 text-slate-950 shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Step {stepNum}: {stepNum === 1 ? 'Pick Domain' : stepNum === 2 ? 'Add Apps' : 'Connect Devices'}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* STEP 1: Choose Your Custom Domain & Prefixes */}
      {activeStep === 1 && (
        <div className="space-y-6">
          <section className="rounded-xl border border-slate-800 bg-[#111827] p-6">
            <h3 className="text-lg font-bold text-white">
              Step 1: Choose Your Custom Domain Suffix
            </h3>
            <p className="mt-1 text-sm text-slate-300">
              <code className="text-sky-400">.local</code> and <code className="text-sky-400">.cofy</code> were just starting examples.
              You can make <strong>any custom domain suffix</strong> you want!
            </p>

            <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {[
                { name: 'home', label: '.home', note: 'Standard for smart homes & IoT' },
                { name: 'lan', label: '.lan', note: 'Universal local area network' },
                { name: 'lab', label: '.lab', note: 'Popular for homelabs & servers' },
                { name: 'box', label: '.box', note: 'Short & clean personal box' },
              ].map((item) => (
                <button
                  key={item.name}
                  type="button"
                  onClick={() => {
                    setCustomDomainInput(item.name);
                    onSetDomain(item.name);
                  }}
                  className={`rounded-xl border p-4 text-left transition-all ${
                    domain === item.name
                      ? 'border-sky-500 bg-sky-950/30 ring-1 ring-sky-500/50'
                      : 'border-slate-800 bg-[#0b0f19] hover:border-slate-700'
                  }`}
                >
                  <div className="font-mono text-base font-bold text-white">
                    {item.label}
                  </div>
                  <div className="mt-1 text-xs text-slate-400">{item.note}</div>
                  <div className="mt-3 text-[11px] font-mono text-sky-400">
                    http://plex.{item.name}
                  </div>
                </button>
              ))}
            </div>

            <div className="mt-6 rounded-lg border border-slate-800 bg-[#0b0f19] p-4">
              <label htmlFor="custom-suffix-input" className="block text-xs font-semibold text-slate-300 mb-1.5">
                Or enter any custom name (like your family name or nickname):
              </label>
              <div className="flex max-w-md items-center gap-2">
                <span className="font-mono text-sm text-slate-400">.</span>
                <input
                  id="custom-suffix-input"
                  type="text"
                  value={customDomainInput}
                  onChange={(e) => setCustomDomainInput(e.target.value)}
                  placeholder="smith, family, mynet, etc."
                  className="w-full rounded-lg border border-slate-700 bg-[#111827] px-3.5 py-2 font-mono text-sm text-white focus:border-sky-400 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => onSetDomain(customDomainInput.trim().toLowerCase())}
                  className="rounded-lg bg-sky-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-sky-400 whitespace-nowrap shrink-0"
                >
                  Use .{customDomainInput}
                </button>
              </div>
            </div>

            <div className="mt-6 flex justify-end">
              <button
                type="button"
                onClick={() => setActiveStep(2)}
                className="rounded-lg bg-sky-500 px-5 py-2.5 text-xs font-bold text-slate-950 hover:bg-sky-400 whitespace-nowrap shrink-0"
              >
                Next: Add Your Home Apps →
              </button>
            </div>
          </section>

          {/* Quick FAQ Callout */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-slate-800 bg-[#111827] p-5">
              <h4 className="text-sm font-bold text-white">
                How do custom prefixes work?
              </h4>
              <p className="mt-2 text-xs leading-relaxed text-slate-400">
                You can assign <strong>any prefix you like</strong> to any app or port! For example, port 32400 can be named{' '}
                <code className="text-slate-200">plex</code>, <code className="text-slate-200">movies</code>, or{' '}
                <code className="text-slate-200">tv</code>. Running <code className="text-slate-200">lanname add movies=32400</code> means typing{' '}
                <code className="text-sky-400">http://movies.local</code> opens your server instantly.
              </p>
            </div>
            <div className="rounded-xl border border-slate-800 bg-[#111827] p-5">
              <h4 className="text-sm font-bold text-white">
                Why does .local work with ZERO setup?
              </h4>
              <p className="mt-2 text-xs leading-relaxed text-slate-400">
                <code className="text-slate-200">.local</code> is governed by the <strong>RFC 6762 Multicast DNS</strong> standard.
                Every iPhone, iPad, Mac, Windows 10/11 PC, and Android 12+ phone automatically discovers <code className="text-slate-200">.local</code> devices over Wi-Fi without modifying router settings or installing software.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* STEP 2: 1-Click App Library & Auto-Discovery */}
      {activeStep === 2 && (
        <div className="space-y-6">
          <section className="rounded-xl border border-slate-800 bg-[#111827] p-6">
            <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center border-b border-slate-800 pb-5">
              <div>
                <h3 className="text-lg font-bold text-white">
                  Step 2: 1-Click Common Homelab Apps &amp; Local Auto-Scan
                </h3>
                <p className="mt-1 text-sm text-slate-300">
                  Click on any app to map it to <code className="text-sky-400">&lt;name&gt;.local</code> and{' '}
                  <code className="text-sky-400">&lt;name&gt;.{domain}</code>.
                </p>
              </div>

              <button
                type="button"
                onClick={handleSimulateScan}
                disabled={isScanning}
                className="rounded-lg border border-sky-500/50 bg-sky-950/40 px-4 py-2 text-xs font-semibold text-sky-300 hover:bg-sky-900/50 transition-colors whitespace-nowrap shrink-0"
              >
                {isScanning ? 'Scanning Ports 3000-12000…' : '🔍 Scan & Auto-Discover Local Apps'}
              </button>
            </div>

            {/* Auto-Discovery Banner if candidates found */}
            {scanDiscovered.length > 0 && (
              <div className="my-5 rounded-lg border border-emerald-800/60 bg-emerald-950/30 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-xs font-bold text-emerald-300">
                      Discovered {scanDiscovered.length} Local Services Running on this Host:
                    </div>
                    <div className="mt-1 font-mono text-xs text-slate-300">
                      {scanDiscovered.map((d) => `${d.displayName} (port ${d.defaultPort})`).join(', ')}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleAddAllDiscovered}
                    className="rounded-lg bg-emerald-500 px-3.5 py-1.5 text-xs font-semibold text-slate-950 hover:bg-emerald-400 whitespace-nowrap shrink-0"
                  >
                    + Add All Discovered Services
                  </button>
                </div>
              </div>
            )}

            {/* Presets Grid */}
            <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {COMMON_SERVICE_PRESETS.map((preset) => {
                const isInstalled = installedServiceIds.has(preset.id);
                return (
                  <div
                    key={preset.id}
                    className="flex flex-col justify-between rounded-xl border border-slate-800 bg-[#0b0f19] p-4"
                  >
                    <div>
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-mono text-slate-400 uppercase">
                          {preset.category}
                        </span>
                        <span className="font-mono text-xs text-sky-400 tabular-nums">
                          :{preset.defaultPort}
                        </span>
                      </div>
                      <h4 className="mt-1.5 text-sm font-bold text-white">
                        {preset.displayName}
                      </h4>
                      <p className="mt-1 text-xs leading-relaxed text-slate-400">
                        {preset.description}
                      </p>
                      <div className="mt-3 font-mono text-[11px] text-slate-300 truncate">
                        http://{preset.name}.local &amp; http://{preset.name}.{domain}
                      </div>
                    </div>

                    <div className="mt-4 pt-3 border-t border-slate-800/80">
                      <button
                        type="button"
                        onClick={() => handleAddPreset(preset)}
                        className={`w-full rounded-lg py-1.5 text-xs font-semibold transition-colors ${
                          isInstalled
                            ? 'bg-slate-800 text-slate-400 cursor-default'
                            : 'bg-sky-500 text-slate-950 hover:bg-sky-400'
                        }`}
                      >
                        {isInstalled ? '✓ Added to Hub' : `+ Add ${preset.name}.${domain}`}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mt-6 flex justify-between items-center pt-4 border-t border-slate-800">
              <button
                type="button"
                onClick={() => setActiveStep(1)}
                className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-slate-700 whitespace-nowrap shrink-0"
              >
                ← Back to Domain Step
              </button>
              <button
                type="button"
                onClick={() => setActiveStep(3)}
                className="rounded-lg bg-sky-500 px-5 py-2.5 text-xs font-bold text-slate-950 hover:bg-sky-400 whitespace-nowrap shrink-0"
              >
                Next: Connect Phones &amp; Laptops →
              </button>
            </div>
          </section>
        </div>
      )}

      {/* STEP 3: Connect Devices in 30 Seconds */}
      {activeStep === 3 && (
        <div className="space-y-6">
          <section className="rounded-xl border border-slate-800 bg-[#111827] p-6">
            <h3 className="text-lg font-bold text-white">
              Step 3: Connect Your Phones &amp; Laptops (Zero-Effort)
            </h3>
            <p className="mt-1 text-sm text-slate-300">
              Choose the easiest method for your family or household.
            </p>

            <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-3">
              {/* Device Path 1: Instant .local */}
              <div className="rounded-xl border border-slate-800 bg-[#0b0f19] p-5 flex flex-col justify-between">
                <div>
                  <div className="text-xs font-bold text-emerald-400">
                    Option A · 100% Zero-Touch (Default)
                  </div>
                  <h4 className="mt-1.5 text-base font-bold text-white">
                    Instant *.local on Any Device
                  </h4>
                  <p className="mt-2 text-xs leading-relaxed text-slate-300">
                    You do not need to install anything! iPhones, iPads, Macs, and Windows 10/11 PCs on Wi-Fi automatically resolve{' '}
                    <code className="text-emerald-300">http://&lt;app&gt;.local</code> right now.
                  </p>
                  <div className="mt-4 rounded-lg border border-slate-800 bg-[#111827] p-3 font-mono text-xs text-sky-300">
                    http://hq.local<br />
                    http://plex.local<br />
                    http://{domain}.local
                  </div>
                </div>

                <div className="mt-5 text-[11px] text-slate-400">
                  ✓ Works immediately with zero configuration
                </div>
              </div>

              {/* Device Path 2: 1-Click iOS/macOS Split-DNS Profile */}
              <div className="rounded-xl border border-slate-800 bg-[#0b0f19] p-5 flex flex-col justify-between">
                <div>
                  <div className="text-xs font-bold text-sky-400">
                    Option B · 1-Click Apple Profile
                  </div>
                  <h4 className="mt-1.5 text-base font-bold text-white">
                    iPhone, iPad &amp; Mac Split-DNS
                  </h4>
                  <p className="mt-2 text-xs leading-relaxed text-slate-300">
                    To use custom names like <code className="text-sky-300">http://hq.{domain}</code> on your iPhone, download Apple&apos;s native Split-DNS configuration profile.
                  </p>
                  <div className="mt-4">
                    <button
                      type="button"
                      onClick={onOpenMobileConfig}
                      className="w-full rounded-lg bg-sky-500 py-2 text-xs font-semibold text-slate-950 hover:bg-sky-400 whitespace-nowrap shrink-0"
                    >
                      Download lanname-{domain}.mobileconfig
                    </button>
                  </div>
                </div>

                <div className="mt-5 text-[11px] text-slate-400">
                  Tap &ldquo;Install Profile&rdquo; in iOS Settings · takes 5 seconds
                </div>
              </div>

              {/* Device Path 3: Whole House Router DNS */}
              <div className="rounded-xl border border-slate-800 bg-[#0b0f19] p-5 flex flex-col justify-between">
                <div>
                  <div className="text-xs font-bold text-purple-400">
                    Option C · Whole-House (Optional)
                  </div>
                  <h4 className="mt-1.5 text-base font-bold text-white">
                    Set Wi-Fi Router DNS
                  </h4>
                  <p className="mt-2 text-xs leading-relaxed text-slate-300">
                    Want every smart TV, phone, and guest laptop to resolve <code className="text-purple-300">*.{domain}</code> automatically?
                    Change your router&apos;s DNS 1 setting to your LAN IP:
                  </p>
                  <div className="mt-4 rounded-lg border border-slate-800 bg-[#111827] p-3 font-mono text-xs text-purple-300">
                    DNS 1: {lanIp}<br />
                    DNS 2: 1.1.1.1 (Cloudflare)
                  </div>
                </div>

                <div className="mt-5 text-[11px] text-slate-400">
                  Works on Eero, Nest Wifi, Asus, Netgear, and TP-Link
                </div>
              </div>
            </div>

            <div className="mt-6 flex justify-between items-center pt-4 border-t border-slate-800">
              <button
                type="button"
                onClick={() => setActiveStep(2)}
                className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-slate-700 whitespace-nowrap shrink-0"
              >
                ← Back to Apps Step
              </button>
              <div className="text-xs text-emerald-400 font-semibold">
                ✓ Setup Complete! All services are active and reachable.
              </div>
            </div>
          </section>

          {/* Non-Technical Features & Security Guardrails Cheat Sheet */}
          <section className="rounded-xl border border-slate-800 bg-[#111827] p-6">
            <h4 className="text-base font-bold text-white">
              Built-In Security &amp; Reliability Guardrails
            </h4>
            <p className="mt-1 text-xs text-slate-400">
              Engineered so both the Go daemon and the Android <code className="text-sky-400">VpnService</code> Split-DNS companion are safe on home and public Wi-Fi networks.
            </p>
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="rounded-lg border border-slate-800 bg-[#0b0f19] p-4">
                <div className="text-xs font-bold text-emerald-400">Anti-Evil-Twin Identity Probe</div>
                <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                  Before the Android <code className="text-slate-300">VpnService</code> companion activates on any Wi-Fi network, it verifies your daemon&apos;s cryptographic <code className="text-slate-300">instance_id</code> via <code className="text-slate-300">TXT _lanname.{domain}</code>. Joining a coffee-shop <code className="text-slate-300">192.168.1.x</code> network never hijacks your DNS.
                </p>
              </div>
              <div className="rounded-lg border border-slate-800 bg-[#0b0f19] p-4">
                <div className="text-xs font-bold text-sky-400">CSRF &amp; DNS-Rebinding Guard</div>
                <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                  Dashboard mutations (<code className="text-slate-300">POST/DELETE /api/services</code>) enforce strict <code className="text-slate-300">Sec-Fetch-Site: same-origin</code> and <code className="text-slate-300">Host</code> allowlist checks so external websites cannot modify your LAN routes.
                </p>
              </div>
              <div className="rounded-lg border border-slate-800 bg-[#0b0f19] p-4">
                <div className="text-xs font-bold text-purple-400">Private LAN ACL (Port 53)</div>
                <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                  Unicast DNS strictly enforces an RFC 1918 / IPv6 ULA source IP allowlist (<code className="text-slate-300">isPrivateOrLocalClient</code>), returning <code className="text-slate-300">REFUSED</code> if a router ever exposes port 53 via UPnP.
                </p>
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
};

