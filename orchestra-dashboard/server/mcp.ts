import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';
import { runProcess } from './process.js';

const CODEX = process.platform === 'win32' ? 'codex.exe' : 'codex';
const home = process.env.USERPROFILE || process.cwd();
const antigravityConfig = resolve(home, '.gemini', 'config', 'mcp_config.json');
const RIDER_NAME = 'rider';
const READ_ONLY_RIDER_TOOLS = new Set([
  'find_files_by_glob', 'find_files_by_name_keyword', 'get_all_open_file_paths', 'get_database_object_description',
  'get_file_problems', 'get_file_text_by_path', 'get_project_dependencies', 'get_repositories',
  'get_run_configurations', 'get_solution_projects', 'list_directory_tree', 'read_file',
  'search_in_files_by_regex', 'search_in_files_by_text',
]);

type JsonRecord = Record<string, any>;
export interface McpAgentStatus { configured: boolean; enabled: boolean; available: boolean; access: 'full' | 'read-only' | 'none'; endpoint: string | null; reason: string | null; }
export interface McpStatus {
  checkedAt: string;
  server: { name: string; version: string | null; operational: boolean; endpoint: string | null; toolCount: number; latencyMs: number | null; reason: string | null };
  agents: { antigravity: McpAgentStatus; codex: McpAgentStatus; gemma: McpAgentStatus };
}
export interface GemmaMcpTool { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }

let statusCache: { at: number; value: McpStatus } | null = null;
let gemmaCapabilityCache: { at: number; available: boolean; reason: string | null } | null = null;

export async function getMcpStatus(force = false): Promise<McpStatus> {
  if (!force && statusCache && Date.now() - statusCache.at < 15_000) return statusCache.value;
  const checkedAt = new Date().toISOString();
  const [codex, antigravity, gemma] = await Promise.all([readCodexRiderConfig(), Promise.resolve(readAntigravityRiderConfig()), probeGemmaToolCalling()]);
  const endpoints = [...new Set([codex.endpoint, antigravity.endpoint].filter((value): value is string => Boolean(value)))];
  const probes = new Map<string, Awaited<ReturnType<typeof probeMcpEndpoint>>>();
  await Promise.all(endpoints.map(async (endpoint) => probes.set(endpoint, await probeMcpEndpoint(endpoint))));
  const preferredEndpoint = codex.endpoint || antigravity.endpoint || null;
  const preferredProbe = preferredEndpoint ? probes.get(preferredEndpoint) : null;
  const statusFor = (input: { configured: boolean; enabled: boolean; endpoint: string | null }, access: McpAgentStatus['access']): McpAgentStatus => {
    const probe = input.endpoint ? probes.get(input.endpoint) : null;
    const available = input.configured && input.enabled && Boolean(probe?.operational);
    return { ...input, available, access: available ? access : 'none', reason: available ? null : !input.configured ? 'Rider is not configured for this agent.' : !input.enabled ? 'The Rider MCP entry is disabled.' : probe?.reason || 'The configured Rider endpoint did not respond.' };
  };
  const antigravityStatus = statusFor(antigravity, 'full');
  const codexStatus = statusFor(codex, 'full');
  const localBridgeEndpoint = preferredEndpoint ? isLoopbackEndpoint(preferredEndpoint) : false;
  const bridgeAvailable = Boolean(preferredProbe?.operational) && gemma.available && localBridgeEndpoint;
  const value: McpStatus = {
    checkedAt,
    server: {
      name: preferredProbe?.serverName || 'JetBrains Rider MCP Server', version: preferredProbe?.version || null,
      operational: Boolean(preferredProbe?.operational), endpoint: preferredEndpoint,
      toolCount: preferredProbe?.tools.length || 0, latencyMs: preferredProbe?.latencyMs || null,
      reason: preferredProbe?.operational ? null : preferredProbe?.reason || 'No Rider MCP endpoint is configured.',
    },
    agents: {
      antigravity: antigravityStatus,
      codex: codexStatus,
      gemma: { configured: true, enabled: true, available: bridgeAvailable, access: bridgeAvailable ? 'read-only' : 'none', endpoint: preferredEndpoint, reason: bridgeAvailable ? null : !localBridgeEndpoint && preferredEndpoint ? 'Gemma MCP bridging is restricted to loopback endpoints.' : gemma.reason || preferredProbe?.reason || 'The Orchestra Rider bridge is unavailable.' },
    },
  };
  statusCache = { at: Date.now(), value };
  return value;
}

export async function getGemmaRiderTools(): Promise<GemmaMcpTool[]> {
  const status = await getMcpStatus();
  if (!status.agents.gemma.available || !status.server.endpoint) return [];
  const probe = await probeMcpEndpoint(status.server.endpoint);
  return probe.tools.filter((tool) => READ_ONLY_RIDER_TOOLS.has(String(tool.name))).map((tool) => ({
    type: 'function',
    function: {
      name: `rider_${String(tool.name)}`,
      description: String(tool.description || `Read-only Rider MCP tool: ${String(tool.name)}`),
      parameters: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} },
    },
  }));
}

export async function callGemmaRiderTool(functionName: string, args: Record<string, unknown>) {
  const toolName = functionName.replace(/^rider_/, '');
  if (!isGemmaRiderToolAllowed(functionName)) throw new Error(`Rider tool ${toolName} is not allowed through Gemma's read-only bridge.`);
  const status = await getMcpStatus();
  if (!status.agents.gemma.available || !status.server.endpoint) throw new Error(status.agents.gemma.reason || 'Gemma Rider bridge is unavailable.');
  const session = await openMcpSession(status.server.endpoint);
  try {
    const result = await session.request('tools/call', { name: toolName, arguments: args });
    return JSON.stringify(result).slice(0, 40_000);
  } finally { await session.close(); }
}

export function isGemmaRiderToolAllowed(functionName: string) { return READ_ONLY_RIDER_TOOLS.has(functionName.replace(/^rider_/, '')); }

async function readCodexRiderConfig() {
  try {
    const result = await runProcess(CODEX, ['mcp', 'list', '--json'], { timeoutMs: 10_000 });
    const entries = JSON.parse(result.stdout) as Array<JsonRecord>;
    const rider = entries.find((entry) => String(entry.name).toLowerCase() === RIDER_NAME);
    return { configured: Boolean(rider), enabled: rider?.enabled === true, endpoint: typeof rider?.transport?.url === 'string' ? rider.transport.url : null };
  } catch { return { configured: false, enabled: false, endpoint: null }; }
}

function readAntigravityRiderConfig() {
  try {
    if (!existsSync(antigravityConfig)) return { configured: false, enabled: false, endpoint: null };
    const value = JSON.parse(readFileSync(antigravityConfig, 'utf8')) as JsonRecord;
    const rider = value.mcpServers?.rider;
    return { configured: Boolean(rider), enabled: Boolean(rider) && rider.disabled !== true, endpoint: typeof rider?.serverUrl === 'string' ? rider.serverUrl : null };
  } catch { return { configured: false, enabled: false, endpoint: null }; }
}

async function probeGemmaToolCalling() {
  if (gemmaCapabilityCache && Date.now() - gemmaCapabilityCache.at < 5 * 60_000) return gemmaCapabilityCache;
  try {
    const response = await fetch(`${config.lmStudioBaseUrl}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        model: config.lmStudioModel, temperature: 0, max_tokens: 40,
        messages: [{ role: 'system', content: 'Call the supplied health function. Do not answer directly.' }, { role: 'user', content: 'Check Rider bridge health.' }],
        tools: [{ type: 'function', function: { name: 'rider_health_check', description: 'Check Rider MCP bridge health.', parameters: { type: 'object', properties: {}, additionalProperties: false } } }], tool_choice: 'auto',
      }),
    });
    if (!response.ok) throw new Error(`LM Studio returned HTTP ${response.status}.`);
    const body = await response.json() as JsonRecord;
    const available = Array.isArray(body.choices?.[0]?.message?.tool_calls) && body.choices[0].message.tool_calls.length > 0;
    gemmaCapabilityCache = { at: Date.now(), available, reason: available ? null : 'The loaded Gemma model did not emit a tool call.' };
  } catch (error) { gemmaCapabilityCache = { at: Date.now(), available: false, reason: error instanceof Error ? error.message : String(error) }; }
  return gemmaCapabilityCache;
}

async function probeMcpEndpoint(endpoint: string) {
  const started = Date.now();
  try {
    const session = await openMcpSession(endpoint);
    try {
      const result = await session.request('tools/list', {});
      return { operational: true, serverName: session.serverName, version: session.version, tools: Array.isArray(result.tools) ? result.tools as JsonRecord[] : [], latencyMs: Date.now() - started, reason: null };
    } finally { await session.close(); }
  } catch (error) {
    return { operational: false, serverName: null, version: null, tools: [] as JsonRecord[], latencyMs: Date.now() - started, reason: error instanceof Error ? error.message : String(error) };
  }
}

async function openMcpSession(endpoint: string) {
  const init = await fetch(endpoint, {
    method: 'POST', signal: AbortSignal.timeout(5_000),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'antigravity-orchestra', version: '1.0.0' } } }),
  });
  if (!init.ok) throw new Error(`Rider MCP initialize returned HTTP ${init.status}.`);
  const sessionId = init.headers.get('mcp-session-id');
  const initialized = await parseMcpResponse(await init.text());
  if (!initialized?.result) throw new Error(String(initialized?.error?.message || 'Rider MCP initialize returned no result.'));
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) };
  await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), signal: AbortSignal.timeout(5_000) });
  let nextId = 2;
  return {
    serverName: String(initialized.result.serverInfo?.name || 'JetBrains Rider MCP Server'),
    version: typeof initialized.result.serverInfo?.version === 'string' ? initialized.result.serverInfo.version : null,
    async request(method: string, params: JsonRecord) {
      const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }), signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`Rider MCP ${method} returned HTTP ${response.status}.`);
      const value = await parseMcpResponse(await response.text());
      if (value?.error) throw new Error(String(value.error.message || JSON.stringify(value.error)));
      return value?.result || {};
    },
    async close() { if (sessionId) await fetch(endpoint, { method: 'DELETE', headers, signal: AbortSignal.timeout(2_000) }).catch(() => undefined); },
  };
}

async function parseMcpResponse(text: string): Promise<JsonRecord> {
  try { return JSON.parse(text) as JsonRecord; }
  catch {
    const data = text.split(/\r?\n/).find((line) => line.startsWith('data:'))?.slice(5).trim();
    if (data) return JSON.parse(data) as JsonRecord;
    throw new Error('Rider MCP returned an unreadable protocol response.');
  }
}

function isLoopbackEndpoint(value: string) {
  try { const url = new URL(value); return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname.toLowerCase()); }
  catch { return false; }
}
