import React, { useState } from 'react';
import {
  ServiceMapping,
  parseServicePair,
  createServiceMapping,
  buildHostsBlock,
} from './utils/lannameCore';
import { QrCodeSvg } from './components/QrCodeSvg';
import { Friendly502PreviewModal } from './components/Friendly502PreviewModal';
import { MobileConfigModal } from './components/MobileConfigModal';
import { ProtocolSimulatorView } from './components/ProtocolSimulatorView';
import { SourceCodeExplorerView } from './components/SourceCodeExplorerView';

type ActiveTab = 'dashboard' | 'simulator' | 'codebase';

const INITIAL_SERVICES: ServiceMapping[] = [
  {
    name: 'hq',
    targetUrl: 'http://127.0.0.1:3100',
    hostPort: '127.0.0.1:3100',
    online: true,
    latencyMs: 2,
  },
  {
    name: 'pool',
    targetUrl: 'http://127.0.0.1:3001',
    hostPort: '127.0.0.1:3001',
    online: true,
    latencyMs: 3,
  },
  {
    name: 'nas',
    targetUrl: 'http://192.168.1.50:8080',
    hostPort: '192.168.1.50:8080',
    online: true,
    latencyMs: 6,
  },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('dashboard');
  const [domain, setDomain] = useState<string>('cofy');
  const [lanIp] = useState<string>('192.168.1.24');
  const [services, setServices] = useState<ServiceMapping[]>(INITIAL_SERVICES);
  const [searchFilter, setSearchFilter] = useState<string>('');

  // Add Service Modal state
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [newSvcName, setNewSvcName] = useState('');
  const [newSvcTarget, setNewSvcTarget] = useState('');
  const [addError, setAddError] = useState<string | null>(null);

  // QR Modal state
  const [qrTarget, setQrTarget] = useState<{
    name: string;
    localUrl: string;
    domainUrl: string;
  } | null>(null);
  const [qrMode, setQrMode] = useState<'local' | 'domain'>('local');

  // 502 Friendly Error Preview state
  const [preview502Svc, setPreview502Svc] = useState<ServiceMapping | null>(
    null
  );

  // iOS MobileConfig Modal state
  const [mobileConfigOpen, setMobileConfigOpen] = useState(false);

  const handleAddServiceSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setAddError(null);
    try {
      const mapping = createServiceMapping(newSvcName, newSvcTarget, true, 2);
      setServices((prev) => {
        const filtered = prev.filter((item) => item.name !== mapping.name);
        return [...filtered, mapping].sort((a, b) =>
          a.name.localeCompare(b.name)
        );
      });
      setNewSvcName('');
      setNewSvcTarget('');
      setAddModalOpen(false);
    } catch (err) {
      setAddError((err as Error).message);
    }
  };

  const handleAddServicePair = (expr: string) => {
    const mapping = parseServicePair(expr, true, 3);
    setServices((prev) => {
      const filtered = prev.filter((item) => item.name !== mapping.name);
      return [...filtered, mapping].sort((a, b) =>
        a.name.localeCompare(b.name)
      );
    });
  };

  const handleRemoveService = (name: string) => {
    const clean = name.trim().toLowerCase();
    setServices((prev) => prev.filter((item) => item.name !== clean));
  };

  const handleToggleOnline = (name: string) => {
    setServices((prev) =>
      prev.map((item) =>
        item.name === name
          ? {
              ...item,
              online: !item.online,
              latencyMs: !item.online ? 2 : 0,
            }
          : item
      )
    );
  };

  const handleBringOnline = (name: string) => {
    setServices((prev) =>
      prev.map((item) =>
        item.name === name ? { ...item, online: true, latencyMs: 2 } : item
      )
    );
  };

  const filteredServices = services.filter(
    (s) =>
      s.name.includes(searchFilter.trim().toLowerCase()) ||
      s.targetUrl.includes(searchFilter.trim().toLowerCase())
  );

  const hostsBlock = buildHostsBlock(
    lanIp,
    domain,
    services.map((s) => s.name)
  );

  const yamlConfigPreview = [
    `domain: ${domain}`,
    `http_port: 80`,
    `dns_port: 53`,
    `upstreams:`,
    `  - 1.1.1.1:53`,
    `  - 8.8.8.8:53`,
    `services:`,
    ...services.map((s) => `  ${s.name}: ${s.targetUrl}`),
  ].join('\n');

  return (
    <div className="min-h-screen bg-[#0b0f19] text-slate-100">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="border-b border-slate-800 bg-[#0b0f19]">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-8 px-6 py-4">
          {/* Zone 1: Single text element wordmark */}
          <a
            href="#top"
            onClick={(e) => {
              e.preventDefault();
              setActiveTab('dashboard');
            }}
            className="text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0"
          >
            lanname
          </a>

          {/* Zone 2: Concise single-line navigation links */}
          <nav
            aria-label="Primary Navigation"
            className="flex items-center gap-6 text-sm font-medium text-slate-300"
          >
            <button
              type="button"
              onClick={() => setActiveTab('dashboard')}
              className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
                activeTab === 'dashboard'
                  ? 'text-sky-400 underline underline-offset-8'
                  : ''
              }`}
            >
              LAN Hub ({domain}.local)
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('simulator')}
              className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
                activeTab === 'simulator'
                  ? 'text-sky-400 underline underline-offset-8'
                  : ''
              }`}
            >
              DNS &amp; CLI Simulator
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('codebase')}
              className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
                activeTab === 'codebase'
                  ? 'text-sky-400 underline underline-offset-8'
                  : ''
              }`}
            >
              Go Source Code (13 Files)
            </button>
            <button
              type="button"
              onClick={() => setMobileConfigOpen(true)}
              className="hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              iOS Split-DNS Profile
            </button>
          </nav>

          {/* Zone 3: 1 Primary Action */}
          <div className="shrink-0">
            <button
              type="button"
              onClick={() => {
                setAddError(null);
                setAddModalOpen(true);
              }}
              className="rounded-lg bg-sky-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-sky-400 transition-colors whitespace-nowrap shrink-0"
            >
              + Add Service
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        {/* Hero Command & Telemetry Strip */}
        <section className="mb-8 rounded-xl border border-slate-800 bg-[#111827] p-6">
          <div className="flex flex-col justify-between gap-6 lg:flex-row lg:items-center">
            <div className="max-w-2xl">
              <div className="text-xs font-medium text-slate-400">
                Single-Binary Go Daemon · Multi-Alias mDNS (UDP 5353) · Authoritative DNS (Port 53) · Reverse Proxy (Port 80)
              </div>
              <h1 className="mt-1.5 text-2xl font-bold tracking-tight text-white sm:text-3xl">
                {domain}.local — Zero-Config Home Network Hub
              </h1>
              <p className="mt-2 text-sm leading-relaxed text-slate-300">
                Every phone and laptop on Wi-Fi resolves{' '}
                <code className="text-sky-400">http://&lt;service&gt;.local</code>{' '}
                immediately via RFC 6762 Multicast DNS, and{' '}
                <code className="text-sky-400">http://&lt;service&gt;.{domain}</code>{' '}
                via local split-DNS and fenced <code className="text-slate-200">/etc/hosts</code> sync.
              </p>
            </div>

            <div className="rounded-lg border border-slate-800 bg-[#0b0f19] p-4 font-mono text-xs">
              <div className="text-slate-400 mb-1">Active CLI Command:</div>
              <div className="text-sky-300 select-all">
                lanname serve{' '}
                {services
                  .map((s) =>
                    s.hostPort.startsWith('127.0.0.1:')
                      ? `${s.name}=${s.hostPort.split(':')[1]}`
                      : `${s.name}=${s.hostPort}`
                  )
                  .join(' ')}{' '}
                --domain {domain}
              </div>
              <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[11px] text-slate-400 tabular-nums">
                <span>Primary LAN IP: {lanIp}</span>
                <span aria-hidden="true">·</span>
                <span>mDNS: 224.0.0.251:5353</span>
                <span aria-hidden="true">·</span>
                <span>DoH Canary: NXDOMAIN</span>
              </div>
            </div>
          </div>
        </section>

        {activeTab === 'dashboard' && (
          <div className="space-y-8">
            {/* Toolbar: Search + Quick Actions */}
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <label htmlFor="service-filter" className="sr-only">
                  Filter Services
                </label>
                <input
                  id="service-filter"
                  type="search"
                  value={searchFilter}
                  onChange={(e) => setSearchFilter(e.target.value)}
                  placeholder="Filter services by name or port…"
                  className="w-64 rounded-lg border border-slate-800 bg-[#111827] px-3.5 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-400 focus:outline-none"
                />
                <span className="text-xs text-slate-400 font-mono tabular-nums">
                  {filteredServices.length} of {services.length} services
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => setMobileConfigOpen(true)}
                  className="rounded-lg border border-slate-700 bg-[#111827] px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
                >
                  Download iOS/macOS Split-DNS Profile (.mobileconfig)
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('codebase')}
                  className="rounded-lg border border-slate-700 bg-[#111827] px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
                >
                  Inspect Go Source Files →
                </button>
              </div>
            </div>

            {/* Service Cards Grid */}
            {filteredServices.length === 0 ? (
              <div className="rounded-xl border border-slate-800 bg-[#111827] p-8 text-center">
                <h2 className="text-base font-semibold text-slate-200">
                  No matching LAN services
                </h2>
                <p className="mt-1 text-xs text-slate-400">
                  Add a service mapping such as <code className="text-slate-200">plex=32400</code> or clear the search filter.
                </p>
                <button
                  type="button"
                  onClick={() => setAddModalOpen(true)}
                  className="mt-4 rounded-lg bg-sky-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-sky-400 transition-colors whitespace-nowrap shrink-0"
                >
                  + Add Service
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
                {filteredServices.map((svc) => {
                  const localUrl = `http://${svc.name}.local`;
                  const domainUrl = `http://${svc.name}.${domain}`;
                  return (
                    <article
                      key={svc.name}
                      className="flex flex-col justify-between rounded-xl border border-slate-800 bg-[#111827] p-5"
                    >
                      <div>
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <h2 className="text-lg font-bold text-white truncate">
                              {svc.name}
                            </h2>
                            <div className="mt-0.5 font-mono text-xs text-slate-400 tabular-nums whitespace-nowrap truncate">
                              → {svc.targetUrl}
                            </div>
                          </div>

                          <button
                            type="button"
                            onClick={() => handleToggleOnline(svc.name)}
                            title="Click to toggle simulated upstream health status"
                            className="inline-flex items-center gap-1.5 text-xs font-semibold font-mono tabular-nums whitespace-nowrap shrink-0"
                          >
                            <span
                              className={`h-2 w-2 rounded-full ${
                                svc.online ? 'bg-emerald-400' : 'bg-red-500'
                              }`}
                            />
                            <span
                              className={
                                svc.online ? 'text-emerald-400' : 'text-red-400'
                              }
                            >
                              {svc.online
                                ? `Online · ${svc.latencyMs}ms`
                                : 'Offline (502)'}
                            </span>
                          </button>
                        </div>

                        <div className="mt-4 space-y-2 font-mono text-xs">
                          <div className="flex items-center justify-between rounded-lg border border-slate-800 bg-[#0b0f19] px-3 py-2">
                            <span className="text-sky-400 truncate">
                              {localUrl}
                            </span>
                            <span className="text-slate-400 text-[11px] shrink-0">
                              mDNS (UDP 5353)
                            </span>
                          </div>
                          <div className="flex items-center justify-between rounded-lg border border-slate-800 bg-[#0b0f19] px-3 py-2">
                            <span className="text-sky-400 truncate">
                              {domainUrl}
                            </span>
                            <span className="text-slate-400 text-[11px] shrink-0">
                              .{domain} (DNS 53)
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 pt-3.5">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setQrMode('local');
                              setQrTarget({
                                name: svc.name,
                                localUrl,
                                domainUrl,
                              });
                            }}
                            className="rounded-lg border border-slate-700 bg-[#0b0f19] px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
                          >
                            QR Code ({svc.name})
                          </button>
                          <button
                            type="button"
                            onClick={() => setPreview502Svc(svc)}
                            className="rounded-lg border border-slate-700 bg-[#0b0f19] px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
                          >
                            502 Page
                          </button>
                        </div>

                        <button
                          type="button"
                          onClick={() => handleRemoveService(svc.name)}
                          aria-label={`Remove ${svc.name}`}
                          className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-red-400 hover:bg-red-950/40 transition-colors whitespace-nowrap shrink-0"
                        >
                          Remove
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}

            {/* Live Config & /etc/hosts Synchronization Preview */}
            <section className="grid grid-cols-1 gap-6 lg:grid-cols-2 items-stretch">
              <div className="rounded-xl border border-slate-800 bg-[#111827] p-5 flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-bold text-slate-100">
                      Fenced /etc/hosts Synchronization (internal/hosts)
                    </h3>
                    <span className="font-mono text-xs text-slate-400">
                      Auto-cleaned on SIGINT/SIGTERM
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-400">
                    Ensures <code className="text-slate-200">http://&lt;service&gt;.{domain}/</code> resolves immediately on the host machine even if the local OS stub resolver does not query port 53.
                  </p>
                </div>
                <pre className="mt-4 rounded-lg border border-slate-800 bg-[#0b0f19] p-3.5 font-mono text-xs text-emerald-300 overflow-x-auto">
                  {hostsBlock}
                </pre>
              </div>

              <div className="rounded-xl border border-slate-800 bg-[#111827] p-5 flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-bold text-slate-100">
                      Persisted State File (lanname.yaml)
                    </h3>
                    <span className="font-mono text-xs text-slate-400">
                      Hot-reloaded via 127.0.0.1:43199
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-400">
                    Atomically updated whenever services are added via <code className="text-slate-200">lanname add</code> or the Web Hub REST API (<code className="text-slate-200">POST /api/services</code>).
                  </p>
                </div>
                <pre className="mt-4 rounded-lg border border-slate-800 bg-[#0b0f19] p-3.5 font-mono text-xs text-sky-300 overflow-x-auto">
                  {yamlConfigPreview}
                </pre>
              </div>
            </section>
          </div>
        )}

        {activeTab === 'simulator' && (
          <ProtocolSimulatorView
            domain={domain}
            lanIp={lanIp}
            services={services}
            onDomainChange={setDomain}
            onAddServicePair={handleAddServicePair}
            onRemoveService={handleRemoveService}
          />
        )}

        {activeTab === 'codebase' && <SourceCodeExplorerView />}
      </main>

      {/* Add Service Modal */}
      {addModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="add-service-modal-title"
        >
          <div className="w-full max-w-md rounded-xl border border-slate-800 bg-[#111827] p-6 shadow-2xl">
            <h3
              id="add-service-modal-title"
              className="text-lg font-bold text-white"
            >
              Add LAN Service Mapping
            </h3>
            <p className="mt-1 text-xs text-slate-400">
              Announces <code className="text-slate-200">&lt;name&gt;.local</code> via UDP 5353 mDNS and resolves{' '}
              <code className="text-slate-200">&lt;name&gt;.{domain}</code> via Port 53 DNS.
            </p>

            <form onSubmit={handleAddServiceSubmit} className="mt-4 space-y-4">
              <div>
                <label
                  htmlFor="input-service-name"
                  className="block text-xs font-medium text-slate-300 mb-1"
                >
                  Service Name
                </label>
                <input
                  id="input-service-name"
                  type="text"
                  required
                  value={newSvcName}
                  onChange={(e) => setNewSvcName(e.target.value)}
                  placeholder="plex"
                  className="w-full rounded-lg border border-slate-700 bg-[#0b0f19] px-3.5 py-2 text-sm text-white focus:border-sky-400 focus:outline-none"
                />
              </div>

              <div>
                <label
                  htmlFor="input-service-target"
                  className="block text-xs font-medium text-slate-300 mb-1"
                >
                  Target Port or Upstream Host:Port
                </label>
                <input
                  id="input-service-target"
                  type="text"
                  required
                  value={newSvcTarget}
                  onChange={(e) => setNewSvcTarget(e.target.value)}
                  placeholder="32400 or 192.168.1.50:8080"
                  className="w-full rounded-lg border border-slate-700 bg-[#0b0f19] px-3.5 py-2 text-sm text-white focus:border-sky-400 focus:outline-none"
                />
              </div>

              {addError && (
                <div
                  role="alert"
                  className="rounded-lg border border-red-800/60 bg-red-950/40 px-3 py-2 text-xs text-red-300"
                >
                  {addError}
                </div>
              )}

              <div className="flex items-center justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setAddModalOpen(false)}
                  className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-slate-700 whitespace-nowrap shrink-0"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-sky-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-sky-400 whitespace-nowrap shrink-0"
                >
                  Save &amp; Announce
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Offline SVG QR Modal */}
      {qrTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="qr-modal-title"
        >
          <div className="w-full max-w-sm rounded-xl border border-slate-800 bg-[#111827] p-6 text-center shadow-2xl">
            <h3 id="qr-modal-title" className="text-lg font-bold text-white">
              Scan on Wi-Fi ({qrTarget.name})
            </h3>
            <p className="mt-1 text-xs text-slate-400">
              100% offline deterministic SVG QR code rendered by{' '}
              <code className="text-slate-200">internal/dashboard</code>
            </p>

            <div className="mt-4 flex justify-center gap-1 rounded-lg bg-[#0b0f19] p-1 border border-slate-800">
              <button
                type="button"
                onClick={() => setQrMode('local')}
                className={`flex-1 rounded-md py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                  qrMode === 'local'
                    ? 'bg-sky-500 text-slate-950'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                {qrTarget.name}.local (Zero-Config)
              </button>
              <button
                type="button"
                onClick={() => setQrMode('domain')}
                className={`flex-1 rounded-md py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                  qrMode === 'domain'
                    ? 'bg-sky-500 text-slate-950'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                {qrTarget.name}.{domain}
              </button>
            </div>

            <div className="my-5 flex justify-center">
              <QrCodeSvg
                value={
                  qrMode === 'local' ? qrTarget.localUrl : qrTarget.domainUrl
                }
              />
            </div>

            <div className="font-mono text-xs text-sky-400">
              {qrMode === 'local' ? qrTarget.localUrl : qrTarget.domainUrl}
            </div>

            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={() => setQrTarget(null)}
                className="w-full rounded-lg border border-slate-700 bg-slate-800 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Friendly 502 Preview Modal */}
      <Friendly502PreviewModal
        service={preview502Svc}
        domain={domain}
        onClose={() => setPreview502Svc(null)}
        onBringOnline={handleBringOnline}
      />

      {/* iOS/macOS Split-DNS .mobileconfig Modal */}
      <MobileConfigModal
        open={mobileConfigOpen}
        domain={domain}
        lanIp={lanIp}
        onClose={() => setMobileConfigOpen(false)}
      />
    </div>
  );
}
