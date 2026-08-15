import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from './config.js';
import { codexAppServer } from './codex-app-server.js';
import { runProcess } from './process.js';

const AGY = process.platform === 'win32' ? 'agy.exe' : 'agy';
const antigravityRoot = resolve(process.env.USERPROFILE || process.cwd(), '.gemini', 'antigravity-cli');
const antigravitySettings = join(antigravityRoot, 'settings.json');
const antigravitySnapshot = join(config.dataDir, 'antigravity-status.json');
let codexCache: { at: number; value: ProviderUsage } | null = null;
let antigravityCache: { at: number; value: ProviderUsage } | null = null;

export interface ProviderUsage {
  available: boolean;
  source: string;
  checkedAt: string;
  reason?: string;
  model?: string;
  context?: { usedPercent: number | null; remainingPercent: number | null; windowTokens: number | null; inputTokens: number | null; outputTokens: number | null };
  quotas?: Array<{ id: string; usedPercent: number | null; remainingPercent: number | null; resetsAt: string | null; windowMinutes: number | null }>;
  tokenActivity?: Record<string, number | null>;
  agentState?: string;
  conversationId?: string;
  workspace?: string;
  stale?: boolean;
}

export function ensureAntigravityStatusCollector() {
  if (!existsSync(antigravitySettings)) return { configured: false, reason: 'Antigravity settings.json was not found.' };
  try {
    const value = JSON.parse(readFileSync(antigravitySettings, 'utf8')) as Record<string, unknown>;
    const status = value.statusLine && typeof value.statusLine === 'object' ? value.statusLine as Record<string, unknown> : {};
    if (typeof status.command === 'string' && status.command.trim()) {
      return { configured: status.command.includes('antigravity-statusline.mjs'), reason: status.command.includes('antigravity-statusline.mjs') ? undefined : 'A different custom Antigravity status-line command is already configured.' };
    }
    const script = join(config.dashboardRoot, 'scripts', 'antigravity-statusline.mjs');
    value.statusLine = { ...status, type: 'command', enabled: true, stack_with_default: true, command: `node ${script}` };
    writeFileSync(antigravitySettings, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    return { configured: true, reason: 'Configured the supported Antigravity status-line collector.' };
  } catch (error) { return { configured: false, reason: error instanceof Error ? error.message : String(error) }; }
}

export async function readAntigravityUsage(): Promise<ProviderUsage> {
  const checkedAt = new Date().toISOString();
  let snapshot: ProviderUsage = { available: false, source: 'antigravity-stream-and-usage', checkedAt, reason: 'No matching Antigravity context snapshot is available yet.' };
  if (existsSync(antigravitySnapshot)) {
  try {
    const value = JSON.parse(readFileSync(antigravitySnapshot, 'utf8')) as Record<string, any>;
    const age = Date.now() - Date.parse(String(value.observedAt || ''));
    const context = value.contextWindow || {};
    const quotas = Object.entries(value.quota || {}).map(([id, raw]) => {
      const bucket = raw as Record<string, unknown>; const remaining = finite(bucket.remaining_fraction);
      return { id, usedPercent: remaining === null ? null : Math.round((1 - remaining) * 10_000) / 100, remainingPercent: remaining === null ? null : Math.round(remaining * 10_000) / 100, resetsAt: stringOrNull(bucket.reset_time), windowMinutes: null };
    });
    snapshot = {
      available: true, source: 'antigravity-statusline', checkedAt: String(value.observedAt || checkedAt), stale: !Number.isFinite(age) || age > 5 * 60_000,
      model: String(value.model?.id || value.model?.displayName || ''), agentState: String(value.agentState || ''), conversationId: String(value.conversationId || ''), workspace: String(value.workspace?.projectDir || value.workspace?.currentDir || ''),
      context: { usedPercent: finite(context.used_percentage), remainingPercent: finite(context.remaining_percentage), windowTokens: finite(context.context_window_size), inputTokens: finite(context.total_input_tokens), outputTokens: finite(context.total_output_tokens) }, quotas,
    };
  } catch (error) { snapshot = { available: false, source: 'antigravity-statusline', checkedAt, reason: `Antigravity telemetry was unreadable: ${error instanceof Error ? error.message : String(error)}` }; }
  }
  const quota = await readAntigravityQuota();
  return {
    ...snapshot,
    available: snapshot.available || quota.available,
    source: snapshot.available ? `${snapshot.source}+${quota.source}` : quota.source,
    checkedAt: quota.available ? quota.checkedAt : snapshot.checkedAt,
    quotas: quota.quotas?.length ? quota.quotas : snapshot.quotas,
    reason: snapshot.available || quota.available ? undefined : [snapshot.reason, quota.reason].filter(Boolean).join(' '),
  };
}

export async function readCodexUsage(): Promise<ProviderUsage> {
  if (codexCache && Date.now() - codexCache.at < 60_000) return codexCache.value;
  const checkedAt = new Date().toISOString();
  try {
    const [rate, activity] = await Promise.all([
      codexAppServer.request('account/rateLimits/read', {}),
      codexAppServer.request('account/usage/read', {}),
    ]);
    const buckets = rate.rateLimitsByLimitId || (rate.rateLimits ? { [rate.rateLimits.limitId || 'codex']: rate.rateLimits } : {});
    const quotas = Object.entries(buckets).map(([id, raw]) => {
      const bucket = raw as Record<string, any>; const primary = bucket.primary || {};
      return { id, usedPercent: finite(primary.usedPercent), remainingPercent: finite(primary.usedPercent) === null ? null : 100 - Number(primary.usedPercent), resetsAt: primary.resetsAt ? new Date(Number(primary.resetsAt) * 1000).toISOString() : null, windowMinutes: finite(primary.windowDurationMins) };
    });
    const summary = activity.summary && typeof activity.summary === 'object' ? activity.summary as Record<string, unknown> : {};
    const tokenActivity = Object.fromEntries(Object.entries(summary).map(([key, value]) => [key, finite(value)]));
    const value: ProviderUsage = { available: quotas.length > 0 || Object.keys(tokenActivity).length > 0, source: 'codex-app-server', checkedAt, quotas, tokenActivity, reason: quotas.length || Object.keys(tokenActivity).length ? undefined : 'Codex account telemetry returned no quota or usage fields for the current authentication mode.' };
    codexCache = { at: Date.now(), value }; return value;
  } catch (error) {
    const value = { available: false, source: 'codex-app-server', checkedAt, reason: error instanceof Error ? error.message : String(error) } satisfies ProviderUsage;
    codexCache = { at: Date.now(), value }; return value;
  }
}

export function readAntigravityTranscript(conversationId: string | null, limit = 30) {
  if (!conversationId || !/^[A-Za-z0-9_-]+$/.test(conversationId)) return [];
  const path = join(antigravityRoot, 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl');
  if (!existsSync(path)) return [];
  const rows: Array<Record<string, unknown>> = [];
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) try {
    const value = JSON.parse(line) as Record<string, any>;
    const calls = Array.isArray(value.tool_calls) ? value.tool_calls.slice(0, 8).map((call: any) => ({ name: String(call.name || call.args?.toolAction || 'tool'), summary: String(call.args?.toolSummary || call.args?.Description || '').slice(0, 500), target: String(call.args?.TargetFile || call.args?.AbsolutePath || '').slice(0, 500) })) : [];
    if (calls.length || ['RUN_COMMAND', 'CODE_ACTION', 'VIEW_FILE', 'CHECKPOINT'].includes(String(value.type))) rows.push({ createdAt: value.created_at, type: value.type, status: value.status, step: value.step_index, tools: calls });
  } catch { /* Ignore incomplete lines during writes. */ }
  return rows.slice(-limit);
}

async function readAntigravityQuota(): Promise<ProviderUsage> {
  if (antigravityCache && Date.now() - antigravityCache.at < 5 * 60_000) return antigravityCache.value;
  const checkedAt = new Date().toISOString();
  try {
    const result = await runProcess(AGY, ['--output-format', 'json', '--print', '/usage'], { timeoutMs: 30_000 });
    if (result.code !== 0) throw new Error(result.stderr.trim() || `Antigravity usage exited with ${result.code}.`);
    const quotas = extractAntigravityQuotas(result.stdout);
    const value: ProviderUsage = { available: quotas.length > 0, source: 'antigravity-/usage', checkedAt, quotas, reason: quotas.length ? undefined : 'Antigravity /usage returned no quota buckets.' };
    antigravityCache = { at: Date.now(), value };
    return value;
  } catch (error) {
    const value: ProviderUsage = { available: false, source: 'antigravity-/usage', checkedAt, reason: error instanceof Error ? error.message : String(error) };
    antigravityCache = { at: Date.now(), value };
    return value;
  }
}

export function extractAntigravityQuotas(output: string): NonNullable<ProviderUsage['quotas']> {
  const quotas: NonNullable<ProviderUsage['quotas']> = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    const record = value as Record<string, unknown>;
    const remaining = finite(record.remaining_fraction);
    if (remaining !== null && (typeof record.id === 'string' || typeof record.name === 'string')) {
      quotas.push({
        id: String(record.id || record.name),
        usedPercent: Math.round((1 - remaining) * 10_000) / 100,
        remainingPercent: Math.round(remaining * 10_000) / 100,
        resetsAt: stringOrNull(record.reset_time),
        windowMinutes: null,
      });
    }
    for (const child of Object.values(record)) if (child && typeof child === 'object') visit(child);
  };
  for (const line of output.split(/\r?\n/)) try { visit(JSON.parse(line)); } catch { /* Ignore non-JSON diagnostics. */ }
  return [...new Map(quotas.map((quota) => [quota.id, quota])).values()];
}

function finite(value: unknown): number | null { const number = Number(value); return Number.isFinite(number) ? number : null; }
function stringOrNull(value: unknown): string | null { return typeof value === 'string' && value ? value : null; }
