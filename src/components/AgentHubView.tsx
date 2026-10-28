import React, { useState } from 'react';
import {
  ServiceMapping,
  authorizeAgentMcpCall,
} from '../utils/lannameCore';

interface AgentHubViewProps {
  services: ServiceMapping[];
  domain: string;
  lanIp: string;
  tailscaleIp: string;
  tailscaleEnabled: boolean;
  allowAgentMutations: boolean;
  agentToken: string;
  onSetAllowAgentMutations: (allow: boolean) => void;
  onRegenerateToken: () => void;
  onAddService: (name: string, target: string) => void;
}

export const AgentHubView: React.FC<AgentHubViewProps> = ({
  services,
  domain,
  lanIp,
  tailscaleIp,
  tailscaleEnabled,
  allowAgentMutations,
  agentToken,
  onSetAllowAgentMutations,
  onRegenerateToken,
  onAddService,
}) => {
  const [activeTab, setActiveTab] = useState<'mcp' | 'tools' | 'python' | 'llmstxt' | 'cli'>('mcp');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Interactive Playground state
  const [selectedTool, setSelectedTool] = useState<
    'callsign_list_services' | 'callsign_resolve' | 'callsign_register_service' | 'callsign_check_health'
  >('callsign_list_services');
  const [simClientIp, setSimClientIp] = useState('100.90.4.12');
  const [includeBearerToken, setIncludeBearerToken] = useState(true);
  const [resolveQuery, setResolveQuery] = useState(services[0]?.name || 'ollama');
  const [newSvcName, setNewSvcName] = useState('agent-preview');
  const [newSvcTarget, setNewSvcTarget] = useState('8000');
  const [simOutput, setSimOutput] = useState<string>('');

  const copyToClipboard = (key: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const runSimulation = () => {
    const authCheck = authorizeAgentMcpCall({
      toolName: selectedTool,
      clientIp: simClientIp,
      allowMutations: allowAgentMutations,
      expectedToken: agentToken,
      authHeader: includeBearerToken ? `Bearer ${agentToken}` : undefined,
    });

    if (!authCheck.allowed) {
      setSimOutput(
        JSON.stringify(
          {
            jsonrpc: '2.0',
            id: 1,
            error: {
              code: authCheck.status === 401 ? -32001 : -32003,
              httpStatus: authCheck.status,
              message: authCheck.reason,
            },
          },
          null,
          2
        )
      );
      return;
    }

    if (selectedTool === 'callsign_list_services') {
      const result = {
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2025-03-26',
          securityCheck: authCheck.reason,
          domain,
          lanIp,
          tailscaleIp: tailscaleEnabled ? tailscaleIp : null,
          total: services.length,
          services: services.map((s) => ({
            name: s.name,
            target: s.targetUrl,
            localUrl: `http://${s.name}.local`,
            domainUrl: `http://${s.name}.${domain}`,
            online: s.online,
            latencyMs: s.latencyMs,
          })),
        },
      };
      setSimOutput(JSON.stringify(result, null, 2));
    } else if (selectedTool === 'callsign_resolve') {
      const match = services.find(
        (s) => s.name.toLowerCase() === resolveQuery.trim().toLowerCase()
      );
      if (match) {
        const result = {
          jsonrpc: '2.0',
          id: 2,
          result: {
            status: 'found',
            name: match.name,
            target: match.targetUrl,
            directHostPort: match.hostPort,
            localUrl: `http://${match.name}.local`,
            domainUrl: `http://${match.name}.${domain}`,
            tailscaleReachable: tailscaleEnabled,
            online: match.online,
            latencyMs: match.latencyMs,
          },
        };
        setSimOutput(JSON.stringify(result, null, 2));
      } else {
        const result = {
          jsonrpc: '2.0',
          id: 2,
          result: {
            status: 'not_found',
            query: resolveQuery,
            availableServices: services.map((s) => s.name),
            message: `Service '${resolveQuery}' is not registered in Callsign.`,
          },
        };
        setSimOutput(JSON.stringify(result, null, 2));
      }
    } else if (selectedTool === 'callsign_register_service') {
      try {
        onAddService(newSvcName.trim(), newSvcTarget.trim());
        const cleanName = newSvcName.trim().toLowerCase();
        const result = {
          jsonrpc: '2.0',
          id: 3,
          result: {
            status: 'registered',
            securityCheck: authCheck.reason,
            service: {
              name: cleanName,
              target: newSvcTarget.trim(),
              localUrl: `http://${cleanName}.local`,
              domainUrl: `http://${cleanName}.${domain}`,
            },
          },
        };
        setSimOutput(JSON.stringify(result, null, 2));
      } catch (err) {
        setSimOutput(
          JSON.stringify(
            {
              jsonrpc: '2.0',
              id: 3,
              error: { code: -32602, message: (err as Error).message },
            },
            null,
            2
          )
        );
      }
    } else if (selectedTool === 'callsign_check_health') {
      const match = services.find(
        (s) => s.name.toLowerCase() === resolveQuery.trim().toLowerCase()
      );
      const result = {
        jsonrpc: '2.0',
        id: 4,
        result: {
          service: resolveQuery,
          online: match ? match.online : false,
          latencyMs: match ? match.latencyMs : 0,
          hostPort: match ? match.hostPort : 'unknown',
        },
      };
      setSimOutput(JSON.stringify(result, null, 2));
    }
  };

  const mcpArgs = allowAgentMutations
    ? ['mcp', '--allow-agent-mutations', '--agent-token', agentToken]
    : ['mcp'];

  const claudeConfig = JSON.stringify(
    {
      mcpServers: {
        callsign: {
          command: 'callsign',
          args: mcpArgs,
        },
      },
    },
    null,
    2
  );

  const remoteHttpMcpConfig = JSON.stringify(
    {
      mcpServers: {
        'callsign-tailscale': {
          url: `http://${tailscaleEnabled ? tailscaleIp : lanIp}/mcp`,
          headers: allowAgentMutations
            ? { Authorization: `Bearer ${agentToken}` }
            : {},
        },
      },
    },
    null,
    2
  );

  const openaiToolsSchema = JSON.stringify(
    [
      {
        type: 'function',
        function: {
          name: 'callsign_list_services',
          description:
            `Lists all active services on the local LAN and Tailscale tailnet with their .local and .${domain} URLs, upstream addresses, and live health status.`,
          parameters: { type: 'object', properties: {} },
        },
      },
      {
        type: 'function',
        function: {
          name: 'callsign_resolve',
          description:
            'Resolves a local service name (e.g. ollama, plex, ha) to its target IP, port, and clean URLs.',
          parameters: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Name of the service (e.g. ollama, plex, ha)',
              },
            },
            required: ['name'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'callsign_register_service',
          description:
            'Dynamically publishes a new local server or port so humans and other agents can access it cleanly.',
          parameters: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Clean hostname prefix (e.g. preview, dev, api)',
              },
              target: {
                type: 'string',
                description: 'Port number (e.g. 8000) or host:port (127.0.0.1:5173)',
              },
            },
            required: ['name', 'target'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'callsign_check_health',
          description:
            'Probes a local service to check if its backend port is accepting TCP connections.',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Name of the service to check' },
            },
            required: ['name'],
          },
        },
      },
    ],
    null,
    2
  );

  const activeHubHost = tailscaleEnabled ? tailscaleIp : lanIp;

  const pythonLangchainSnippet = `import requests

# Works identically on Home Wi-Fi (${lanIp}) or over Tailscale (${tailscaleIp})
CALLSIGN_HUB = "http://${activeHubHost}"
AGENT_TOKEN = "${agentToken}"

def resolve_service(name: str) -> str | None:
    """Discovers a service's live endpoint without hardcoding ports."""
    res = requests.get(f"{CALLSIGN_HUB}/api/status", timeout=2)
    for svc in res.json().get("services", []):
        if svc["name"].lower() == name.lower():
            return svc["domainUrl"]  # e.g. "http://ollama.${domain}"
    return None

def publish_agent_preview(name: str, port: int):
    """Registers a temporary dev server with Scoped Bearer Token security."""
    headers = {"Authorization": f"Bearer {AGENT_TOKEN}"}
    return requests.post(
        f"{CALLSIGN_HUB}/api/services",
        json={"name": name, "target": str(port)},
        headers=headers,
        timeout=2,
    ).json()
`;

  const llmsTxtContent = `# Callsign Network & Service Directory
> Machine-readable LAN and Tailscale topology for AI agents.

## Network Horizon
- Primary LAN IP: ${lanIp}
- Tailscale Mesh IP: ${tailscaleEnabled ? tailscaleIp : 'Disabled'}
- Custom Domain Suffix: .${domain}
- mDNS Suffix: .local
- MCP Endpoint (Streamable HTTP): http://${activeHubHost}/mcp
- OpenAPI 3.1 Spec: http://${activeHubHost}/openapi.json

## Active Services
${
  services.length === 0
    ? '- (No services currently registered — add apps in the My Apps tab or via callsign_register_service)'
    : services
        .map(
          (s) =>
            `- ${s.name}: http://${s.name}.${domain} | http://${s.name}.local -> ${s.targetUrl} (${
              s.online ? `Online, ${s.latencyMs}ms` : 'Offline'
            })`
        )
        .join('\n')
}
`;

  return (
    <div className="space-y-8">
      {/* Header & 3 Core Capabilities */}
      <section className="rounded-2xl border border-slate-800 bg-[#111827] p-6 sm:p-8">
        <div className="max-w-3xl">
          <div className="text-xs font-medium text-sky-400">
            Model Context Protocol (MCP) · Tailscale Mesh · Zero-Trust ACLs
          </div>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-white sm:text-3xl">
            AI Agent Discovery &amp; Tool Gateway
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-300">
            Give local and cloud AI agents (Claude Desktop, Cursor, Windsurf, OpenAI, LangChain) instant discovery of your home services over LAN or Tailscale—protected by strict Read-Only defaults and Scoped Bearer Tokens.
          </p>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-4 border-t border-slate-800 pt-6 sm:grid-cols-3">
          <div>
            <h2 className="text-sm font-semibold text-white">
              01. Native MCP Server
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-400">
              Run <code className="text-slate-200">callsign mcp</code> over stdio or connect remote agents over Tailscale HTTP <code className="text-slate-200">POST /mcp</code>.
            </p>
          </div>

          <div>
            <h2 className="text-sm font-semibold text-white">
              02. Zero Port Guessing
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-400">
              Agents call <code className="text-slate-200">callsign_resolve</code> to find <code className="text-sky-400">http://ollama.{domain}</code> or publish previews dynamically.
            </p>
          </div>

          <div>
            <h2 className="text-sm font-semibold text-white">
              03. Zero-Trust Security
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-400">
              Read-only by default. Route mutations require explicit opt-in and a cryptographic Bearer token (<code className="text-slate-200">cs_tok_...</code>).
            </p>
          </div>
        </div>
      </section>

      {/* Security & Access Policy Controls */}
      <section className="rounded-2xl border border-slate-800 bg-[#111827] p-6">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <h2 className="text-base font-bold text-white">
              Agent Security &amp; Permission Policy
            </h2>
            <p className="mt-0.5 text-xs text-slate-400">
              Control whether AI agents can only discover existing services or also register new routes.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onSetAllowAgentMutations(false)}
              className={`rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                !allowAgentMutations
                  ? 'bg-sky-500 text-slate-950'
                  : 'border border-slate-800 bg-[#0b0f19] text-slate-400 hover:text-white'
              }`}
            >
              Read-Only Discovery (Default)
            </button>
            <button
              type="button"
              onClick={() => onSetAllowAgentMutations(true)}
              className={`rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                allowAgentMutations
                  ? 'bg-emerald-500 text-slate-950'
                  : 'border border-slate-800 bg-[#0b0f19] text-slate-400 hover:text-white'
              }`}
            >
              Allow Token-Authenticated Writes
            </button>
          </div>
        </div>

        <div className="mt-4 flex flex-col justify-between gap-3 rounded-xl border border-slate-800 bg-[#0b0f19] p-4 sm:flex-row sm:items-center">
          <div className="min-w-0">
            <div className="text-xs font-medium text-slate-400">
              Scoped Agent Bearer Token (Required for HTTP /mcp and API mutations)
            </div>
            <div className="mt-1 font-mono text-xs tabular-nums text-sky-300 truncate select-all">
              {agentToken}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => copyToClipboard('token', agentToken)}
              className="rounded-lg border border-slate-700 bg-[#111827] px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              {copiedKey === 'token' ? 'Copied' : 'Copy Token'}
            </button>
            <button
              type="button"
              onClick={onRegenerateToken}
              className="rounded-lg border border-slate-700 bg-[#111827] px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              Rotate Token
            </button>
          </div>
        </div>
      </section>

      {/* Interactive Tool Calling & MCP Simulator */}
      <section className="rounded-2xl border border-slate-800 bg-[#111827] p-6">
        <div className="flex flex-col justify-between gap-4 border-b border-slate-800 pb-4 sm:flex-row sm:items-center">
          <div>
            <h2 className="text-base font-bold text-white">
              Interactive MCP Tool Playground
            </h2>
            <p className="text-xs text-slate-400">
              Simulate JSON-RPC 2.0 tool calls from local, Tailscale, or external IPs against your live configuration.
            </p>
          </div>
          <button
            type="button"
            onClick={runSimulation}
            className="rounded-xl bg-sky-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-sky-400 transition-colors whitespace-nowrap shrink-0"
          >
            Run Tool Call
          </button>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-6 lg:grid-cols-12">
          <div className="space-y-4 lg:col-span-5">
            <div>
              <label className="text-xs font-semibold text-slate-300">
                1. Select MCP Tool
              </label>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {[
                  { id: 'callsign_list_services', label: 'list_services' },
                  { id: 'callsign_resolve', label: 'resolve' },
                  { id: 'callsign_register_service', label: 'register_service' },
                  { id: 'callsign_check_health', label: 'check_health' },
                ].map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setSelectedTool(t.id as any)}
                    className={`rounded-lg border px-3 py-2 text-left font-mono text-xs transition-colors whitespace-nowrap truncate ${
                      selectedTool === t.id
                        ? 'border-sky-500 bg-sky-950/40 text-sky-300 font-bold'
                        : 'border-slate-800 bg-[#0b0f19] text-slate-400 hover:text-white'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-xs font-semibold text-slate-300">
                2. Simulated Agent Source IP
              </label>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {[
                  { label: 'Tailscale (100.90.4.12)', ip: '100.90.4.12' },
                  { label: 'Localhost (127.0.0.1)', ip: '127.0.0.1' },
                  { label: 'Public Blocked (8.8.4.4)', ip: '8.8.4.4' },
                ].map((p) => (
                  <button
                    key={p.ip}
                    type="button"
                    onClick={() => setSimClientIp(p.ip)}
                    className={`rounded border px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                      simClientIp === p.ip
                        ? 'border-sky-500 bg-sky-500/10 text-sky-300'
                        : 'border-slate-800 bg-[#0b0f19] text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {(selectedTool === 'callsign_resolve' ||
              selectedTool === 'callsign_check_health') && (
              <div>
                <label
                  htmlFor="agent-resolve-input"
                  className="text-xs font-semibold text-slate-300"
                >
                  Service Name Argument
                </label>
                <input
                  id="agent-resolve-input"
                  type="text"
                  value={resolveQuery}
                  onChange={(e) => setResolveQuery(e.target.value)}
                  placeholder="e.g. ollama, plex, ha"
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-[#0b0f19] px-3 py-2 font-mono text-xs text-white focus:border-sky-500 focus:outline-none"
                />
              </div>
            )}

            {selectedTool === 'callsign_register_service' && (
              <div className="space-y-3 rounded-xl border border-slate-800 bg-[#0b0f19] p-3.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-300">
                    New Service Arguments
                  </span>
                  <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={includeBearerToken}
                      onChange={(e) => setIncludeBearerToken(e.target.checked)}
                    />
                    Send Bearer Token
                  </label>
                </div>
                <div>
                  <label
                    htmlFor="agent-new-name"
                    className="block text-xs text-slate-400"
                  >
                    Service Name
                  </label>
                  <input
                    id="agent-new-name"
                    type="text"
                    value={newSvcName}
                    onChange={(e) => setNewSvcName(e.target.value)}
                    className="mt-1 w-full rounded border border-slate-700 bg-[#111827] px-2.5 py-1.5 font-mono text-xs text-white"
                  />
                </div>
                <div>
                  <label
                    htmlFor="agent-new-target"
                    className="block text-xs text-slate-400"
                  >
                    Port or Host:Port
                  </label>
                  <input
                    id="agent-new-target"
                    type="text"
                    value={newSvcTarget}
                    onChange={(e) => setNewSvcTarget(e.target.value)}
                    className="mt-1 w-full rounded border border-slate-700 bg-[#111827] px-2.5 py-1.5 font-mono text-xs tabular-nums text-white"
                  />
                </div>
              </div>
            )}
          </div>

          {/* JSON-RPC Output Console */}
          <div className="flex flex-col rounded-xl border border-slate-800 bg-[#0b0f19] p-4 lg:col-span-7">
            <div className="flex items-center justify-between border-b border-slate-800 pb-2">
              <span className="font-mono text-xs text-slate-400">
                JSON-RPC 2.0 Response
              </span>
              <button
                type="button"
                onClick={() =>
                  copyToClipboard('sim', simOutput || 'Run tool call first')
                }
                className="text-xs font-medium text-sky-400 hover:text-sky-300 whitespace-nowrap shrink-0"
              >
                {copiedKey === 'sim' ? 'Copied' : 'Copy JSON'}
              </button>
            </div>
            <pre className="mt-3 flex-1 overflow-x-auto font-mono text-xs tabular-nums text-sky-300 select-all leading-relaxed max-h-72">
              {simOutput ||
                '{\n  "info": "Click Run Tool Call above to inspect the live MCP response"\n}'}
            </pre>
          </div>
        </div>
      </section>

      {/* Integration Snippets */}
      <section className="rounded-2xl border border-slate-800 bg-[#111827] p-6">
        <h2 className="text-base font-bold text-white">
          Copy-Paste Agent Configurations
        </h2>
        <p className="mt-1 text-xs text-slate-400">
          Drop these directly into Claude Desktop, Cursor, OpenAI/Gemini SDKs, or LangChain.
        </p>

        <div className="mt-4 flex flex-wrap gap-2 border-b border-slate-800 pb-3">
          {[
            { id: 'mcp', label: 'Claude & Cursor (MCP)' },
            { id: 'tools', label: 'OpenAI / Gemini Tools' },
            { id: 'python', label: 'Python & Tailscale' },
            { id: 'llmstxt', label: '/llms.txt Directory' },
            { id: 'cli', label: 'CLI JSON Flags' },
          ].map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTab(t.id as any)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                activeTab === t.id
                  ? 'bg-slate-800 text-white font-semibold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {activeTab === 'mcp' && (
          <div className="mt-4 space-y-4">
            <div className="text-xs text-slate-300">
              <strong>Option A — Local Subprocess (stdio):</strong> For Claude Desktop or Cursor running on the same machine:
            </div>
            <div className="relative rounded-xl border border-slate-800 bg-[#0b0f19] p-4">
              <button
                type="button"
                onClick={() => copyToClipboard('claude', claudeConfig)}
                className="absolute right-3 top-3 rounded bg-slate-800 px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-slate-700 whitespace-nowrap shrink-0"
              >
                {copiedKey === 'claude' ? 'Copied' : 'Copy JSON'}
              </button>
              <pre className="font-mono text-xs text-sky-300 overflow-x-auto select-all">
                {claudeConfig}
              </pre>
            </div>

            <div className="text-xs text-slate-300 pt-2">
              <strong>Option B — Remote Over Tailscale (Streamable HTTP):</strong> For agents on remote laptops or cloud runners connected to your tailnet:
            </div>
            <div className="relative rounded-xl border border-slate-800 bg-[#0b0f19] p-4">
              <button
                type="button"
                onClick={() => copyToClipboard('remote-mcp', remoteHttpMcpConfig)}
                className="absolute right-3 top-3 rounded bg-slate-800 px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-slate-700 whitespace-nowrap shrink-0"
              >
                {copiedKey === 'remote-mcp' ? 'Copied' : 'Copy JSON'}
              </button>
              <pre className="font-mono text-xs tabular-nums text-sky-300 overflow-x-auto select-all">
                {remoteHttpMcpConfig}
              </pre>
            </div>
          </div>
        )}

        {activeTab === 'tools' && (
          <div className="mt-4 space-y-4">
            <p className="text-xs text-slate-300">
              Standard Function Calling JSON Schema compatible with OpenAI, Gemini, and Anthropic tool arrays:
            </p>
            <div className="relative rounded-xl border border-slate-800 bg-[#0b0f19] p-4">
              <button
                type="button"
                onClick={() => copyToClipboard('tools_schema', openaiToolsSchema)}
                className="absolute right-3 top-3 rounded bg-slate-800 px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-slate-700 whitespace-nowrap shrink-0"
              >
                {copiedKey === 'tools_schema' ? 'Copied' : 'Copy Schema'}
              </button>
              <pre className="font-mono text-xs text-emerald-300 overflow-x-auto max-h-80 select-all">
                {openaiToolsSchema}
              </pre>
            </div>
          </div>
        )}

        {activeTab === 'python' && (
          <div className="mt-4 space-y-4">
            <p className="text-xs text-slate-300">
              Discover services or publish new agent endpoints from Python over LAN or Tailscale:
            </p>
            <div className="relative rounded-xl border border-slate-800 bg-[#0b0f19] p-4">
              <button
                type="button"
                onClick={() => copyToClipboard('python', pythonLangchainSnippet)}
                className="absolute right-3 top-3 rounded bg-slate-800 px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-slate-700 whitespace-nowrap shrink-0"
              >
                {copiedKey === 'python' ? 'Copied' : 'Copy Python'}
              </button>
              <pre className="font-mono text-xs tabular-nums text-sky-300 overflow-x-auto max-h-80 select-all">
                {pythonLangchainSnippet}
              </pre>
            </div>
          </div>
        )}

        {activeTab === 'llmstxt' && (
          <div className="mt-4 space-y-4">
            <p className="text-xs text-slate-300">
              Served automatically at <code className="text-slate-200">http://{activeHubHost}/llms.txt</code> for web-browsing agents:
            </p>
            <div className="relative rounded-xl border border-slate-800 bg-[#0b0f19] p-4">
              <button
                type="button"
                onClick={() => copyToClipboard('llmstxt', llmsTxtContent)}
                className="absolute right-3 top-3 rounded bg-slate-800 px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-slate-700 whitespace-nowrap shrink-0"
              >
                {copiedKey === 'llmstxt' ? 'Copied' : 'Copy Markdown'}
              </button>
              <pre className="font-mono text-xs tabular-nums text-slate-300 overflow-x-auto max-h-80 select-all">
                {llmsTxtContent}
              </pre>
            </div>
          </div>
        )}

        {activeTab === 'cli' && (
          <div className="mt-4 space-y-3">
            <p className="text-xs text-slate-300">
              Machine-readable CLI commands for terminal agents (Claude Code, Cline, OpenHands, Aider):
            </p>
            <div className="rounded-xl border border-slate-800 bg-[#0b0f19] p-3.5 font-mono text-xs">
              <div className="text-slate-400">List all active services and health in JSON:</div>
              <div className="mt-1 text-sky-300 select-all">callsign ls --json</div>
            </div>
            <div className="rounded-xl border border-slate-800 bg-[#0b0f19] p-3.5 font-mono text-xs">
              <div className="text-slate-400">Start the stdio Model Context Protocol server:</div>
              <div className="mt-1 text-sky-300 select-all">
                callsign mcp {allowAgentMutations ? `--allow-agent-mutations --agent-token ${agentToken}` : ''}
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
};
