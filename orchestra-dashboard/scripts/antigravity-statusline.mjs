import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;

try {
  const value = JSON.parse(input);
  const snapshot = {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    conversationId: string(value.conversation_id || value.session_id),
    transcriptPath: string(value.transcript_path),
    workspace: {
      currentDir: string(value.workspace?.current_dir || value.cwd),
      projectDir: string(value.workspace?.project_dir),
    },
    model: { id: string(value.model?.id), displayName: string(value.model?.display_name) },
    contextWindow: finiteObject(value.context_window),
    quota: quotaObject(value.quota),
    agentState: string(value.agent_state),
    executionMode: string(value.execution_mode),
    pendingInputCount: finite(value.pending_input_count),
    taskCount: finite(value.task_count),
    toolConfirmationPending: value.tool_confirmation_pending === true,
    exceeds200kTokens: typeof value.exceeds_200k_tokens === 'boolean' ? value.exceeds_200k_tokens : null,
    planTier: string(value.plan_tier),
    version: string(value.version),
  };
  const dataDir = process.env.ORCHESTRA_DATA_DIR || join(process.env.LOCALAPPDATA || process.cwd(), 'AntigravityOrchestra');
  const path = join(dataDir, 'antigravity-status.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(snapshot), { encoding: 'utf8', mode: 0o600 });
  const context = snapshot.contextWindow?.used_percentage;
  const contextText = Number.isFinite(context) ? ` · context ${Math.round(context)}%` : '';
  process.stdout.write(`Orchestra · ${snapshot.agentState || 'idle'}${contextText}`);
} catch {
  process.stdout.write('Orchestra · telemetry unavailable');
}

function string(value) { return typeof value === 'string' ? value.slice(0, 2_000) : ''; }
function finite(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
function finiteObject(value) {
  if (!value || typeof value !== 'object') return null;
  const result = {};
  for (const key of ['total_input_tokens', 'total_output_tokens', 'context_window_size', 'used_percentage', 'remaining_percentage']) result[key] = finite(value[key]);
  if (value.current_usage && typeof value.current_usage === 'object') {
    result.current_usage = {};
    for (const key of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) result.current_usage[key] = finite(value.current_usage[key]);
  }
  return result;
}
function quotaObject(value) {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, bucket]) => [key.slice(0, 120), {
    remaining_fraction: finite(bucket?.remaining_fraction),
    reset_time: string(bucket?.reset_time),
    reset_in_seconds: finite(bucket?.reset_in_seconds),
  }]));
}
