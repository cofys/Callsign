import React, { useState } from 'react';
import {
  ServiceMapping,
  COMMON_SERVICE_PRESETS,
  ServicePreset,
  parseServicePair,
  createServiceMapping,
} from './utils/lannameCore';
import { QrCodeSvg } from './components/QrCodeSvg';
import { Friendly502PreviewModal } from './components/Friendly502PreviewModal';
import { MobileConfigModal } from './components/MobileConfigModal';
import { AndroidCompanionModal } from './components/AndroidCompanionModal';
import { ProtocolSimulatorView } from './components/ProtocolSimulatorView';
import { SourceCodeExplorerView } from './components/SourceCodeExplorerView';
import { DomainManagerModal } from './components/DomainManagerModal';
import { SetupWizardView } from './components/SetupWizardView';
import { AgentHubView } from './components/AgentHubView';

type ActiveTab = 'apps' | 'setup' | 'agents' | 'developer';
type DevSubTab = 'code' | 'simulator';

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('apps');
  const [devSubTab, setDevSubTab] = useState<DevSubTab>('code');
  const [domain, setDomain] = useState<string>('x');
  const [lanIp] = useState<string>('192.168.1.100');
  const [tailscaleIp, setTailscaleIp] = useState<string>('100.85.12.34');
  const [tailscaleEnabled, setTailscaleEnabled] = useState<boolean>(true);
  const [allowAgentMutations, setAllowAgentMutations] = useState<boolean>(false);
  const [agentToken, setAgentToken] = useState<string>('cs_tok_9f8e7d6c5b4a3210');
  const [showAdvancedDrawer, setShowAdvancedDrawer] = useState<boolean>(false);
  const [services, setServices] = useState<ServiceMapping[]>([]);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Add App Modal state
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

  // Android Companion APK Modal state
  const [androidModalOpen, setAndroidModalOpen] = useState(false);

  // Custom Domain Manager Modal state
  const [domainModalOpen, setDomainModalOpen] = useState(false);

  const handleCopyText = (key: string, text: string) => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
    setCopiedKey(key);
    setTimeout(() => {
      setCopiedKey((prev) => (prev === key ? null : prev));
    }, 1800);
  };

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

  const handleQuickAddPreset = (preset: ServicePreset) => {
    try {
      const mapping = createServiceMapping(
        preset.name,
        String(preset.defaultPort),
        true,
        2
      );
      setServices((prev) => {
        const filtered = prev.filter((item) => item.name !== mapping.name);
        return [...filtered, mapping].sort((a, b) =>
          a.name.localeCompare(b.name)
        );
      });
    } catch {
      // ignore
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

  const servicePairsStr = services
    .map((s) =>
      s.hostPort.startsWith('127.0.0.1:')
        ? `${s.name}=${s.hostPort.split(':')[1]}`
        : `${s.name}=${s.hostPort}`
    )
    .join(' ');

  const cliCommand = servicePairsStr
    ? `callsign serve ${servicePairsStr} --domain ${domain}`
    : `callsign serve --domain ${domain}`;

  const availablePresets = COMMON_SERVICE_PRESETS.filter(
    (p) => !services.some((s) => s.name === p.name)
  ).slice(0, 5);

  return (
    <div className="min-h-screen bg-[#0b0f19] text-slate-100">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="border-b border-slate-800/80 bg-[#0b0f19]">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-6 px-6 py-4">
          {/* Zone 1: Brand Wordmark */}
          <a
            href="#top"
            onClick={(e) => {
              e.preventDefault();
              setActiveTab('apps');
            }}
            className="text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0"
          >
            Callsign
          </a>

          {/* Zone 2: Minimalist 4-Item Navigation */}
          <nav
            aria-label="Primary Navigation"
            className="flex items-center gap-6 text-sm font-medium text-slate-400"
          >
            <button
              type="button"
              onClick={() => setActiveTab('apps')}
              className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
                activeTab === 'apps'
                  ? 'text-white underline decoration-sky-400 decoration-2 underline-offset-8 font-semibold'
                  : ''
              }`}
            >
              My Apps
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('setup')}
              className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
                activeTab === 'setup'
                  ? 'text-white underline decoration-sky-400 decoration-2 underline-offset-8 font-semibold'
                  : ''
              }`}
            >
              Phone &amp; Tailscale
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('agents')}
              className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
                activeTab === 'agents'
                  ? 'text-white underline decoration-sky-400 decoration-2 underline-offset-8 font-semibold'
                  : ''
              }`}
            >
              AI Agents
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('developer')}
              className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
                activeTab === 'developer'
                  ? 'text-white underline decoration-sky-400 decoration-2 underline-offset-8 font-semibold'
                  : ''
              }`}
            >
              Source &amp; Tools
            </button>
          </nav>

          {/* Zone 3: Single Primary Action */}
          <div className="shrink-0">
            <button
              type="button"
              onClick={() => {
                setAddError(null);
                setAddModalOpen(true);
              }}
              className="rounded-xl bg-sky-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-sky-400 transition-colors whitespace-nowrap shrink-0"
            >
              + Add App
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-10">
        {/* TAB 1: MINIMALIST, DUMMY-PROOF "MY APPS" HOME */}
        {activeTab === 'apps' && (
          <div className="space-y-8">
            {/* Simple, Calm Header */}
            <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
              <div>
                <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
                  Your Home Network Apps
                </h1>
                <p className="mt-1 text-sm text-slate-400">
                  Add your local apps below to open them without typing IP addresses or port numbers.
                </p>
              </div>

              <div className="flex items-center gap-3 text-xs">
                <span className="text-slate-400">
                  Custom ending:{' '}
                  <strong className="font-mono text-slate-200">
                    .{domain}
                  </strong>
                  {tailscaleEnabled && (
                    <span className="text-slate-500">
                      {' '}
                      · Tailscale {tailscaleIp}
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => setDomainModalOpen(true)}
                  className="rounded-lg border border-slate-800 bg-[#111827] px-3 py-1.5 font-medium text-sky-400 hover:border-slate-700 hover:text-sky-300 whitespace-nowrap shrink-0"
                >
                  Change
                </button>
              </div>
            </div>

            {/* 1-Click Quick-Add Bar for Non-Technical Users */}
            {availablePresets.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-800/80 bg-[#111827]/60 px-4 py-3">
                <span className="text-xs font-medium text-slate-400 mr-1">
                  1-Click Add:
                </span>
                {availablePresets.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => handleQuickAddPreset(preset)}
                    className="rounded-lg border border-slate-800 bg-[#0b0f19] px-3 py-1 text-xs font-medium text-slate-300 hover:border-sky-500/50 hover:text-white transition-colors whitespace-nowrap shrink-0"
                  >
                    +{' '}
                    {preset.displayName
                      .replace(' Media Server', '')
                      .replace(' Local AI', '')
                      .replace(' Dashboard', '')}
                  </button>
                ))}
              </div>
            )}

            {/* Minimalist App Cards Grid */}
            {services.length === 0 ? (
              <div className="rounded-2xl border border-slate-800 bg-[#111827] p-12 text-center">
                <h2 className="text-base font-semibold text-white">
                  No apps configured yet
                </h2>
                <p className="mt-1 text-sm text-slate-400">
                  Click <strong>+ Add App</strong> or pick a preset above to create your first clean <code className="text-sky-400">.local</code> and <code className="text-sky-400">.{domain}</code> link.
                </p>
                <button
                  type="button"
                  onClick={() => setAddModalOpen(true)}
                  className="mt-5 rounded-xl bg-sky-500 px-5 py-2.5 text-xs font-semibold text-slate-950 hover:bg-sky-400 transition-colors whitespace-nowrap shrink-0"
                >
                  + Add App
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {services.map((svc) => {
                  const localUrl = `http://${svc.name}.local`;
                  const domainUrl = `http://${svc.name}.${domain}`;
                  const isCopied = copiedKey === svc.name;
                  return (
                    <article
                      key={svc.name}
                      className="flex flex-col justify-between rounded-2xl border border-slate-800/90 bg-[#111827] p-5 transition-colors hover:border-slate-700"
                    >
                      <div>
                        {/* Data Point 1: App Name & Simple Status */}
                        <div className="flex items-center justify-between gap-2">
                          <h2 className="text-lg font-bold text-white truncate">
                            {svc.name}
                          </h2>
                          <button
                            type="button"
                            onClick={() => handleToggleOnline(svc.name)}
                            title="Click to simulate online/offline status"
                            className="inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap shrink-0"
                          >
                            <span
                              className={`h-2 w-2 rounded-full ${
                                svc.online ? 'bg-emerald-400' : 'bg-amber-400'
                              }`}
                            />
                            <span
                              className={
                                svc.online
                                  ? 'text-slate-400'
                                  : 'text-amber-300'
                              }
                            >
                              {svc.online ? 'Ready' : 'Offline'}
                            </span>
                          </button>
                        </div>

                        {/* Data Point 2: Clean URLs */}
                        <div className="mt-4 rounded-xl border border-slate-800 bg-[#0b0f19] p-3.5">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono text-sm font-semibold text-sky-400 truncate">
                              {localUrl}
                            </span>
                            <button
                              type="button"
                              onClick={() => handleCopyText(svc.name, localUrl)}
                              className="text-xs font-medium text-slate-400 hover:text-white whitespace-nowrap shrink-0"
                            >
                              {isCopied ? 'Copied!' : 'Copy'}
                            </button>
                          </div>
                          <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-slate-500">
                            <span className="font-mono truncate">
                              or {domainUrl}
                            </span>
                            <span className="font-mono tabular-nums shrink-0">
                              :{svc.hostPort.split(':')[1] || '80'}
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* Data Point 3: Simple Actions */}
                      <div className="mt-4 flex items-center justify-between pt-2 text-xs">
                        <div className="flex items-center gap-3">
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
                            className="font-medium text-slate-300 hover:text-white whitespace-nowrap shrink-0"
                          >
                            Phone QR
                          </button>
                          {!svc.online && (
                            <button
                              type="button"
                              onClick={() => setPreview502Svc(svc)}
                              className="font-medium text-amber-400 hover:text-amber-300 whitespace-nowrap shrink-0"
                            >
                              View Recovery Page
                            </button>
                          )}
                        </div>

                        <button
                          type="button"
                          onClick={() => handleRemoveService(svc.name)}
                          aria-label={`Remove ${svc.name}`}
                          className="text-slate-500 hover:text-red-400 transition-colors whitespace-nowrap shrink-0"
                        >
                          Remove
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}

            {/* Quiet 1-Line Command Footer + Optional Advanced Security Drawer */}
            <div className="space-y-3">
              <div className="flex flex-col justify-between gap-3 rounded-2xl border border-slate-800/80 bg-[#111827] px-5 py-4 sm:flex-row sm:items-center">
                <div className="min-w-0">
                  <div className="text-xs font-medium text-slate-400">
                    Run this command on your home computer:
                  </div>
                  <div className="mt-1 font-mono text-xs text-sky-300 truncate select-all">
                    {cliCommand}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => setShowAdvancedDrawer(!showAdvancedDrawer)}
                    aria-expanded={showAdvancedDrawer}
                    className="rounded-xl border border-slate-800 bg-[#0b0f19] px-3.5 py-2 text-xs font-medium text-slate-400 hover:text-white whitespace-nowrap shrink-0"
                  >
                    {showAdvancedDrawer ? 'Hide Advanced' : 'Advanced Security'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleCopyText('cli', cliCommand)}
                    className="rounded-xl border border-slate-700 bg-[#0b0f19] px-4 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 whitespace-nowrap shrink-0"
                  >
                    {copiedKey === 'cli' ? 'Copied' : 'Copy Command'}
                  </button>
                </div>
              </div>

              {showAdvancedDrawer && (
                <div className="rounded-2xl border border-slate-800 bg-[#111827] p-5 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-800">
                    <div>
                      <div className="font-semibold text-white">
                        Advanced Security &amp; Tailscale Mesh Controls
                      </div>
                      <div className="text-slate-400">
                        Zero-trust defaults are active automatically. Customize Tailscale Split-Horizon or AI Agent permissions below.
                      </div>
                    </div>
                  </div>
                  <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
                    <div className="rounded-xl border border-slate-800 bg-[#0b0f19] p-3.5">
                      <div className="font-medium text-white">
                        Port 53 Private + CGNAT ACL
                      </div>
                      <p className="mt-1 text-slate-400">
                        Only answers RFC1918 LAN (<code className="font-mono tabular-nums text-slate-300">192.168.0.0/16</code>) and Tailscale (<code className="font-mono tabular-nums text-slate-300">100.64.0.0/10</code>). Public internet queries receive <code className="text-emerald-400">REFUSED</code>.
                      </p>
                    </div>
                    <div className="rounded-xl border border-slate-800 bg-[#0b0f19] p-3.5">
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-white">Tailscale Horizon</span>
                        <button
                          type="button"
                          onClick={() => setTailscaleEnabled(!tailscaleEnabled)}
                          className="text-sky-400 hover:text-sky-300 font-medium"
                        >
                          {tailscaleEnabled ? 'Active' : 'Disabled'}
                        </button>
                      </div>
                      <p className="mt-1 text-slate-400">
                        Answers Tailscale peers with <code className="font-mono tabular-nums text-sky-300">{tailscaleIp}</code> and Wi-Fi peers with <code className="font-mono tabular-nums text-sky-300">{lanIp}</code>.
                      </p>
                    </div>
                    <div className="rounded-xl border border-slate-800 bg-[#0b0f19] p-3.5">
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-white">AI Agent MCP Access</span>
                        <button
                          type="button"
                          onClick={() => setActiveTab('agents')}
                          className="text-sky-400 hover:text-sky-300 font-medium"
                        >
                          Configure
                        </button>
                      </div>
                      <p className="mt-1 text-slate-400">
                        Mode: <strong className="text-slate-200">{allowAgentMutations ? 'Token-Authenticated Read/Write' : 'Read-Only Discovery'}</strong>.
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 2: SIMPLE PHONE & TAILSCALE SETUP */}
        {activeTab === 'setup' && (
          <SetupWizardView
            domain={domain}
            lanIp={lanIp}
            tailscaleIp={tailscaleIp}
            tailscaleEnabled={tailscaleEnabled}
            onSetDomain={setDomain}
            onSetTailscaleIp={setTailscaleIp}
            onSetTailscaleEnabled={setTailscaleEnabled}
            onOpenMobileConfig={() => setMobileConfigOpen(true)}
            onOpenAndroidModal={() => setAndroidModalOpen(true)}
          />
        )}

        {/* TAB 3: AI AGENTS (MCP & TOOL CALLING) */}
        {activeTab === 'agents' && (
          <AgentHubView
            services={services}
            domain={domain}
            lanIp={lanIp}
            tailscaleIp={tailscaleIp}
            tailscaleEnabled={tailscaleEnabled}
            allowAgentMutations={allowAgentMutations}
            agentToken={agentToken}
            onSetAllowAgentMutations={setAllowAgentMutations}
            onRegenerateToken={() => {
              const rand = Math.random().toString(16).slice(2, 14);
              setAgentToken(`cs_tok_${rand}`);
            }}
            onAddService={(name, target) => {
              const mapping = createServiceMapping(name, target, true, 2);
              setServices((prev) => {
                const filtered = prev.filter((item) => item.name !== mapping.name);
                return [...filtered, mapping].sort((a, b) =>
                  a.name.localeCompare(b.name)
                );
              });
            }}
          />
        )}

        {/* TAB 4: SOURCE CODE & SIMULATOR (TUCKED AWAY FOR DEVELOPERS) */}
        {activeTab === 'developer' && (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
              <div>
                <h1 className="text-xl font-bold text-white">
                  Source Code &amp; Protocol Tools
                </h1>
                <p className="mt-0.5 text-xs text-slate-400">
                  Complete Go daemon source, MCP server, Universal Android APK project, and live packet simulator.
                </p>
              </div>

              <div className="flex items-center gap-2 rounded-xl border border-slate-800 bg-[#111827] p-1">
                <button
                  type="button"
                  onClick={() => setDevSubTab('code')}
                  className={`rounded-lg px-3.5 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                    devSubTab === 'code'
                      ? 'bg-sky-500 text-slate-950'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  Source Files (19)
                </button>
                <button
                  type="button"
                  onClick={() => setDevSubTab('simulator')}
                  className={`rounded-lg px-3.5 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                    devSubTab === 'simulator'
                      ? 'bg-sky-500 text-slate-950'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  DNS &amp; CLI Simulator
                </button>
              </div>
            </div>

            {devSubTab === 'code' ? (
              <SourceCodeExplorerView />
            ) : (
              <ProtocolSimulatorView
                domain={domain}
                lanIp={lanIp}
                services={services}
                onDomainChange={setDomain}
                onAddServicePair={handleAddServicePair}
                onRemoveService={handleRemoveService}
              />
            )}
          </div>
        )}
      </main>

      {/* Add App Modal */}
      {addModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="add-service-modal-title"
        >
          <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-[#111827] p-6 shadow-2xl">
            <h3
              id="add-service-modal-title"
              className="text-lg font-bold text-white"
            >
              Add an App
            </h3>
            <p className="mt-1 text-xs text-slate-400">
              Give your app a short name and enter its port number.
            </p>

            <form onSubmit={handleAddServiceSubmit} className="mt-4 space-y-4">
              <div>
                <label
                  htmlFor="input-service-name"
                  className="block text-xs font-medium text-slate-300 mb-1"
                >
                  Short Name (e.g. plex, tv, ha)
                </label>
                <input
                  id="input-service-name"
                  type="text"
                  required
                  value={newSvcName}
                  onChange={(e) => setNewSvcName(e.target.value)}
                  placeholder="plex"
                  className="w-full rounded-xl border border-slate-700 bg-[#0b0f19] px-3.5 py-2 text-sm text-white focus:border-sky-400 focus:outline-none"
                />
              </div>

              <div>
                <label
                  htmlFor="input-service-target"
                  className="block text-xs font-medium text-slate-300 mb-1"
                >
                  Port Number (or IP:Port)
                </label>
                <input
                  id="input-service-target"
                  type="text"
                  required
                  value={newSvcTarget}
                  onChange={(e) => setNewSvcTarget(e.target.value)}
                  placeholder="32400"
                  className="w-full rounded-xl border border-slate-700 bg-[#0b0f19] px-3.5 py-2 text-sm text-white focus:border-sky-400 focus:outline-none"
                />
              </div>

              {addError && (
                <div
                  role="alert"
                  className="rounded-xl border border-red-800/60 bg-red-950/40 px-3 py-2 text-xs text-red-300"
                >
                  {addError}
                </div>
              )}

              <div className="flex items-center justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setAddModalOpen(false)}
                  className="rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-slate-700 whitespace-nowrap shrink-0"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-xl bg-sky-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-sky-400 whitespace-nowrap shrink-0"
                >
                  Add App
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
          <div className="w-full max-w-sm rounded-2xl border border-slate-800 bg-[#111827] p-6 text-center shadow-2xl">
            <h3 id="qr-modal-title" className="text-lg font-bold text-white">
              Open {qrTarget.name} on Your Phone
            </h3>
            <p className="mt-1 text-xs text-slate-400">
              Point your phone camera at this QR code while on Wi-Fi.
            </p>

            <div className="mt-4 flex justify-center gap-1 rounded-xl bg-[#0b0f19] p-1 border border-slate-800">
              <button
                type="button"
                onClick={() => setQrMode('local')}
                className={`flex-1 rounded-lg py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                  qrMode === 'local'
                    ? 'bg-sky-500 text-slate-950'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                {qrTarget.name}.local
              </button>
              <button
                type="button"
                onClick={() => setQrMode('domain')}
                className={`flex-1 rounded-lg py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
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
                className="w-full rounded-xl border border-slate-700 bg-slate-800 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700"
              >
                Done
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

      {/* Android Universal APK & Setup Modal */}
      <AndroidCompanionModal
        open={androidModalOpen}
        domain={domain}
        lanIp={lanIp}
        onClose={() => setAndroidModalOpen(false)}
        onInspectSource={() => {
          setDevSubTab('code');
          setActiveTab('developer');
        }}
      />

      {/* Custom Domain Manager Modal */}
      <DomainManagerModal
        open={domainModalOpen}
        currentDomain={domain}
        onClose={() => setDomainModalOpen(false)}
        onSaveDomain={setDomain}
      />
    </div>
  );
}
