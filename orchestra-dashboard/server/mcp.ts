import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';
import { runProcess } from './process.js';
import { getLoadedLmStudioModels } from './agents.js';

const CODEX = process.platform === 'win32' ? 'codex.exe' : 'codex';
const home = process.env.USERPROFILE || process.cwd();
const antigravityGlobalConfig = resolve(home, '.gemini', 'config', 'mcp_config.json');
const antigravityLocalConfig = resolve(home, '.gemini', 'antigravity-cli', 'mcp.json');
const antigravitySchemasDir = resolve(home, '.gemini', 'antigravity-cli', 'mcp');
const codexConfigPath = resolve(home, '.codex', 'config.toml');

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

export interface McpServerRecord {
  id: string;
  name: string;
  enabled: boolean;
  transportType: 'http' | 'stdio';
  endpoint: string | null;
  command: string | null;
  args: string[];
  operational: boolean;
  toolCount: number;
  tools: string[];
  latencyMs: number | null;
  models: {
    antigravity: boolean;
    codex: boolean;
    gemma: boolean;
  };
  sources: {
    antigravityGlobal: boolean;
    antigravityLocal: boolean;
    codex: boolean;
  };
  reason: string | null;
}

let statusCache: { at: number; value: McpStatus } | null = null;
let serversCache: { at: number; value: McpServerRecord[] } | null = null;
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

export async function listAllMcpServers(force = false): Promise<McpServerRecord[]> {
  if (!force && serversCache && Date.now() - serversCache.at < 10_000) return serversCache.value;

  const serverMap = new Map<string, McpServerRecord>();

  const getOrCreate = (id: string, name: string): McpServerRecord => {
    const key = id.toLowerCase();
    let existing = serverMap.get(key);
    if (!existing) {
      existing = {
        id: key,
        name,
        enabled: true,
        transportType: 'stdio',
        endpoint: null,
        command: null,
        args: [],
        operational: false,
        toolCount: 0,
        tools: [],
        latencyMs: null,
        models: { antigravity: false, codex: false, gemma: false },
        sources: { antigravityGlobal: false, antigravityLocal: false, codex: false },
        reason: null,
      };
      serverMap.set(key, existing);
    }
    return existing;
  };

  // 1. Scan Antigravity Global Config
  if (existsSync(antigravityGlobalConfig)) {
    try {
      const data = JSON.parse(readFileSync(antigravityGlobalConfig, 'utf8')) as JsonRecord;
      if (data.mcpServers && typeof data.mcpServers === 'object') {
        for (const [key, val] of Object.entries(data.mcpServers as Record<string, JsonRecord>)) {
          const rec = getOrCreate(key, key);
          rec.sources.antigravityGlobal = true;
          rec.models.antigravity = true;
          if (val.disabled === true) rec.enabled = false;
          if (val.serverUrl) {
            rec.transportType = 'http';
            rec.endpoint = String(val.serverUrl);
          } else if (val.args && Array.isArray(val.args)) {
            const httpArg = val.args.find((a: unknown) => typeof a === 'string' && a.startsWith('http://'));
            if (httpArg) {
              rec.transportType = 'http';
              rec.endpoint = String(httpArg);
            }
          }
          if (val.command) rec.command = String(val.command);
          if (Array.isArray(val.args)) rec.args = val.args.map(String);
        }
      }
    } catch { /* ignore JSON parse error */ }
  }

  // 2. Scan Antigravity Local Config
  if (existsSync(antigravityLocalConfig)) {
    try {
      const data = JSON.parse(readFileSync(antigravityLocalConfig, 'utf8')) as JsonRecord;
      if (data.mcpServers && typeof data.mcpServers === 'object') {
        for (const [key, val] of Object.entries(data.mcpServers as Record<string, JsonRecord>)) {
          const rec = getOrCreate(key, key);
          rec.sources.antigravityLocal = true;
          rec.models.antigravity = true;
          if (val.disabled === true) rec.enabled = false;
          if (val.serverUrl) {
            rec.transportType = 'http';
            rec.endpoint = String(val.serverUrl);
          }
          if (val.command) rec.command = String(val.command);
          if (Array.isArray(val.args)) rec.args = val.args.map(String);
        }
      }
    } catch { /* ignore */ }
  }

  // 3. Scan Codex Config TOML
  if (existsSync(codexConfigPath)) {
    try {
      const tomlContent = readFileSync(codexConfigPath, 'utf8');
      const codexServers = parseCodexMcpServersFromToml(tomlContent);
      for (const cs of codexServers) {
        const rec = getOrCreate(cs.name, cs.name);
        rec.sources.codex = true;
        rec.models.codex = true;
        if (cs.enabled === false) rec.enabled = false;
        if (cs.url) {
          rec.transportType = 'http';
          rec.endpoint = cs.url;
        }
        if (cs.command) rec.command = cs.command;
      }
    } catch { /* ignore */ }
  }

  // 4. Discover Schema Tools from .gemini/antigravity-cli/mcp/
  for (const [id, rec] of serverMap.entries()) {
    const schemaTools = getToolSchemasForServer(rec.name) || getToolSchemasForServer(id);
    if (schemaTools.length > 0) {
      rec.toolCount = schemaTools.length;
      rec.tools = schemaTools;
    }
  }

  // 5. Probe Live HTTP Endpoints
  await Promise.all(
    Array.from(serverMap.values()).map(async (rec) => {
      if (rec.transportType === 'http' && rec.endpoint) {
        const probe = await probeMcpEndpoint(rec.endpoint);
        rec.operational = probe.operational;
        rec.latencyMs = probe.latencyMs;
        if (probe.operational) {
          if (probe.tools.length > 0) {
            rec.toolCount = probe.tools.length;
            rec.tools = probe.tools.map((t) => String(t.name));
          }
        } else {
          rec.reason = probe.reason;
        }
      } else {
        // STDIO servers: operational if enabled and command/schemas exist
        rec.operational = rec.enabled && (Boolean(rec.command) || rec.toolCount > 0);
      }

      // Rider connects to Gemma bridge
      if (rec.id === 'rider') {
        rec.models.gemma = rec.operational && rec.enabled;
      }
    })
  );

  const results = Array.from(serverMap.values()).sort((a, b) => a.name.localeCompare(b.name));
  serversCache = { at: Date.now(), value: results };
  return results;
}

export async function toggleMcpServer(serverKey: string, enabled: boolean): Promise<McpServerRecord | null> {
  const normalized = serverKey.toLowerCase();

  // 1. Update Antigravity Global Config
  if (existsSync(antigravityGlobalConfig)) {
    updateAntigravityConfigFile(antigravityGlobalConfig, serverKey, enabled);
  }

  // 2. Update Antigravity Local Config
  if (existsSync(antigravityLocalConfig)) {
    updateAntigravityConfigFile(antigravityLocalConfig, serverKey, enabled);
  }

  // 3. Update Codex Config TOML
  if (existsSync(codexConfigPath)) {
    try {
      const raw = readFileSync(codexConfigPath, 'utf8');
      const updated = updateCodexMcpServerEnabledInToml(raw, serverKey, enabled);
      writeFileSync(codexConfigPath, updated, 'utf8');
    } catch (err) {
      console.error(`Failed to update Codex config TOML:`, err);
    }
  }

  // 4. If disabling, proactively terminate any lingering background processes (e.g. godot-mcp-enhanced)
  if (!enabled && process.platform === 'win32') {
    if (normalized.includes('godot')) {
      void runProcess('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like "*godot-mcp-enhanced*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`]).catch(() => undefined);
    }
  }

  // Invalidate caches
  statusCache = null;
  serversCache = null;

  const refreshed = await listAllMcpServers(true);
  return refreshed.find((s) => s.id === normalized) || null;
}

export function parseCodexMcpServersFromToml(content: string): Array<{ name: string; enabled: boolean; url: string | null; command: string | null }> {
  const results: Array<{ name: string; enabled: boolean; url: string | null; command: string | null }> = [];
  const lines = content.split(/\r?\n/);
  let currentServer: { name: string; enabled: boolean; url: string | null; command: string | null } | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    const sectionMatch = trimmed.match(/^\[mcp_servers\.(['"]?)([a-zA-Z0-9_-]+)\1\]$/);
    if (sectionMatch) {
      if (currentServer) results.push(currentServer);
      currentServer = { name: sectionMatch[2], enabled: true, url: null, command: null };
      continue;
    }

    if (trimmed.startsWith('[') && !trimmed.startsWith('[mcp_servers.')) {
      if (currentServer) {
        results.push(currentServer);
        currentServer = null;
      }
      continue;
    }

    if (currentServer) {
      const enabledMatch = trimmed.match(/^enabled\s*=\s*(true|false)/i);
      if (enabledMatch) currentServer.enabled = enabledMatch[1].toLowerCase() === 'true';

      const disabledMatch = trimmed.match(/^disabled\s*=\s*(true|false)/i);
      if (disabledMatch) currentServer.enabled = disabledMatch[1].toLowerCase() !== 'true';

      const urlMatch = trimmed.match(/^url\s*=\s*['"]([^'"]+)['"]/i);
      if (urlMatch) currentServer.url = urlMatch[1];

      const cmdMatch = trimmed.match(/^command\s*=\s*['"]([^'"]+)['"]/i);
      if (cmdMatch) currentServer.command = cmdMatch[1];
    }
  }

  if (currentServer) results.push(currentServer);
  return results;
}

export function updateCodexMcpServerEnabledInToml(content: string, serverName: string, enabled: boolean): string {
  const escaped = serverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sectionHeaderRegex = new RegExp(`^\\[mcp_servers\\.(?:'|"|)${escaped}(?:'|"|)\\]`, 'im');
  const match = sectionHeaderRegex.exec(content);
  if (!match) return content;

  const startIndex = match.index;
  const afterHeaderIndex = startIndex + match[0].length;
  const nextSectionMatch = content.slice(afterHeaderIndex).search(/\n\[[a-zA-Z0-9_."'-]+\]/);
  const sectionEndIndex = nextSectionMatch === -1 ? content.length : afterHeaderIndex + nextSectionMatch;

  let sectionBody = content.slice(startIndex, sectionEndIndex);
  if (/^\s*enabled\s*=\s*(true|false)/im.test(sectionBody)) {
    sectionBody = sectionBody.replace(/^\s*enabled\s*=\s*(true|false)/im, `enabled = ${enabled}`);
  } else {
    sectionBody = sectionBody.replace(sectionHeaderRegex, `${match[0]}\nenabled = ${enabled}`);
  }

  return content.slice(0, startIndex) + sectionBody + content.slice(sectionEndIndex);
}

function updateAntigravityConfigFile(filePath: string, serverKey: string, enabled: boolean) {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw) as JsonRecord;
    if (!data.mcpServers || typeof data.mcpServers !== 'object') return;

    const actualKey = Object.keys(data.mcpServers).find((k) => k.toLowerCase() === serverKey.toLowerCase()) || serverKey;
    if (data.mcpServers[actualKey]) {
      if (enabled) {
        delete data.mcpServers[actualKey].disabled;
      } else {
        data.mcpServers[actualKey].disabled = true;
      }
      writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    }
  } catch (err) {
    console.error(`Failed to update Antigravity config file ${filePath}:`, err);
  }
}

function getToolSchemasForServer(serverName: string): string[] {
  try {
    const dir = resolve(antigravitySchemasDir, serverName);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  } catch {
    return [];
  }
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
    if (!existsSync(antigravityGlobalConfig)) return { configured: false, enabled: false, endpoint: null };
    const value = JSON.parse(readFileSync(antigravityGlobalConfig, 'utf8')) as JsonRecord;
    const rider = value.mcpServers?.rider;
    return { configured: Boolean(rider), enabled: Boolean(rider) && rider.disabled !== true, endpoint: typeof rider?.serverUrl === 'string' ? rider.serverUrl : null };
  } catch { return { configured: false, enabled: false, endpoint: null }; }
}

async function probeGemmaToolCalling() {
  if (gemmaCapabilityCache && Date.now() - gemmaCapabilityCache.at < 5 * 60_000) return gemmaCapabilityCache;
  try {
    const loadedModels = await getLoadedLmStudioModels();
    if (loadedModels.length === 0) {
      gemmaCapabilityCache = { at: Date.now(), available: false, reason: 'No local model is currently loaded in LM Studio.' };
      return gemmaCapabilityCache;
    }
    const modelToProbe = loadedModels[0];
    const response = await fetch(`${config.lmStudioBaseUrl}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        model: modelToProbe, temperature: 0, max_tokens: 40,
        messages: [{ role: 'system', content: 'Call the supplied health function. Do not answer directly.' }, { role: 'user', content: 'Check Rider bridge health.' }],
        tools: [{ type: 'function', function: { name: 'rider_health_check', description: 'Check Rider MCP bridge health.', parameters: { type: 'object', properties: {}, additionalProperties: false } } }], tool_choice: 'auto',
      }),
    });
    if (!response.ok) throw new Error(`LM Studio returned HTTP ${response.status}.`);
    const body = await response.json() as JsonRecord;
    const available = Array.isArray(body.choices?.[0]?.message?.tool_calls) && body.choices[0].message.tool_calls.length > 0;
    gemmaCapabilityCache = { at: Date.now(), available, reason: available ? null : 'The loaded local model did not emit a tool call.' };
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
