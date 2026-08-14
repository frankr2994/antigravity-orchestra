import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const CODEX = process.platform === 'win32' ? 'codex.exe' : 'codex';

type JsonRecord = Record<string, any>;
type NotificationHandler = (method: string, params: JsonRecord) => void;

export interface CodexContextSnapshot {
  threadId: string;
  turnId: string;
  context: {
    usedPercent: number | null;
    remainingPercent: number | null;
    windowTokens: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
  };
  usage: Record<string, number>;
}

export interface CodexTurnResult {
  text: string;
  threadId: string;
  turnId: string;
  telemetry: CodexContextSnapshot | null;
}

export interface CodexTurnOptions {
  root: string;
  prompt: string;
  model: string;
  effort: string;
  signal: AbortSignal;
  onOutput: (message: string) => void;
  onTelemetry?: (value: CodexContextSnapshot | Record<string, unknown>) => void;
}

export function normalizeCodexTokenUsage(params: JsonRecord): CodexContextSnapshot | null {
  const tokenUsage = params.tokenUsage;
  if (!tokenUsage || typeof tokenUsage !== 'object') return null;
  const total = tokenUsage.total && typeof tokenUsage.total === 'object' ? tokenUsage.total : {};
  const windowTokens = finite(tokenUsage.modelContextWindow);
  const totalTokens = finite(total.totalTokens);
  const usedPercent = windowTokens && totalTokens !== null ? Math.min(100, Math.round(totalTokens / windowTokens * 10_000) / 100) : null;
  return {
    threadId: String(params.threadId || ''),
    turnId: String(params.turnId || ''),
    context: {
      usedPercent,
      remainingPercent: usedPercent === null ? null : Math.max(0, Math.round((100 - usedPercent) * 100) / 100),
      windowTokens,
      inputTokens: finite(total.inputTokens),
      outputTokens: finite(total.outputTokens),
      totalTokens,
    },
    usage: {
      inputTokens: finite(total.inputTokens) || 0,
      cachedInputTokens: finite(total.cachedInputTokens) || 0,
      cacheWriteInputTokens: finite(total.cacheWriteInputTokens) || 0,
      outputTokens: finite(total.outputTokens) || 0,
      reasoningOutputTokens: finite(total.reasoningOutputTokens) || 0,
      totalTokens: totalTokens || 0,
    },
  };
}

export function codexProgressMessage(method: string, params: JsonRecord): string | null {
  if (method === 'item/started') {
    const item = params.item || {};
    if (item.type === 'commandExecution') return friendlyCommandActivity(String(item.command || ''));
    if (item.type === 'todoList') return `Planning ${Array.isArray(item.items) ? item.items.length : 'the'} analysis steps.`;
    if (item.type === 'contextCompaction') return 'Codex is compacting its context before continuing.';
  }
  if (method === 'item/completed') {
    const item = params.item || {};
    if (item.type === 'commandExecution' && item.status === 'failed') return 'A read-only repository inspection step failed; Codex is trying another approach.';
    if (item.type === 'contextCompaction') return 'Codex completed context compaction.';
  }
  return null;
}

class CodexAppServer {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private nextId = 1;
  private buffer = '';
  private stderr = '';
  private pending = new Map<number, { resolve: (value: JsonRecord) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private listeners = new Set<NotificationHandler>();

  async request(method: string, params: JsonRecord = {}, timeoutMs = 15_000): Promise<JsonRecord> {
    await this.ensureStarted();
    return this.rawRequest(method, params, timeoutMs);
  }

  async runReadOnlyTurn(options: CodexTurnOptions): Promise<CodexTurnResult> {
    const threadResponse = await this.request('thread/start', {
      cwd: options.root,
      model: options.model,
      approvalPolicy: 'never',
      ephemeral: true,
    }, 30_000);
    const threadId = String(threadResponse.thread?.id || '');
    if (!threadId) throw new Error('Codex app-server did not return a thread id.');

    let turnId = '';
    let finalText = '';
    let deltaText = '';
    let telemetry: CodexContextSnapshot | null = null;
    const notices = new Set<string>();
    let resolveTurn!: () => void;
    let rejectTurn!: (error: Error) => void;
    const completed = new Promise<void>((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
    const notify = (method: string, params: JsonRecord) => {
      if (params.threadId !== threadId || (turnId && params.turnId && params.turnId !== turnId)) return;
      if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') deltaText += params.delta;
      if (method === 'item/completed' && params.item?.type === 'agentMessage' && typeof params.item.text === 'string') finalText = params.item.text;
      if (method === 'thread/tokenUsage/updated') {
        const snapshot = normalizeCodexTokenUsage(params);
        if (snapshot) { telemetry = snapshot; options.onTelemetry?.(snapshot); }
      }
      if (method === 'model/rerouted') {
        options.onTelemetry?.({ threadId, turnId: String(params.turnId || turnId), reroute: { fromModel: params.fromModel, toModel: params.toModel, reason: params.reason } });
        options.onOutput(`Codex was rerouted from ${String(params.fromModel)} to ${String(params.toModel)} by the provider.`);
      }
      const progress = codexProgressMessage(method, params);
      if (progress && !notices.has(progress)) { notices.add(progress); options.onOutput(progress); }
      if (method === 'turn/completed') {
        const status = String(params.turn?.status || 'completed');
        if (status === 'completed') resolveTurn();
        else rejectTurn(new Error(codexTurnError(params.turn, status)));
      }
    };
    this.listeners.add(notify);
    let timeout: NodeJS.Timeout | undefined;
    const abort = () => {
      if (turnId) void this.request('turn/interrupt', { threadId, turnId }).catch(() => undefined);
      rejectTurn(new Error('Codex turn cancelled.'));
    };
    options.signal.addEventListener('abort', abort, { once: true });
    try {
      if (options.signal.aborted) throw new Error('Codex turn cancelled.');
      const turnResponse = await this.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: options.prompt }],
        cwd: options.root,
        model: options.model,
        effort: options.effort,
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        summary: 'concise',
      }, 30_000);
      turnId = String(turnResponse.turn?.id || '');
      if (!turnId) throw new Error('Codex app-server did not return a turn id.');
      timeout = setTimeout(() => {
        void this.request('turn/interrupt', { threadId, turnId }).catch(() => undefined);
        rejectTurn(new Error('Codex app-server turn timed out after 15 minutes.'));
      }, 15 * 60_000);
      await completed;
      const text = finalText.trim() || deltaText.trim();
      return { text, threadId, turnId, telemetry };
    } finally {
      if (timeout) clearTimeout(timeout);
      options.signal.removeEventListener('abort', abort);
      this.listeners.delete(notify);
    }
  }

  close() {
    const child = this.child;
    this.child = null;
    this.starting = null;
    if (child && !child.killed) child.kill();
  }

  private async ensureStarted() {
    if (this.child && !this.child.killed) return;
    if (!this.starting) this.starting = this.start();
    try { await this.starting; }
    catch (error) { this.close(); throw error; }
    finally { this.starting = null; }
  }

  private async start() {
    const child = spawn(CODEX, ['app-server'], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.buffer = '';
    this.stderr = '';
    child.stdout.on('data', (data: Buffer) => this.handleData(data.toString()));
    child.stderr.on('data', (data: Buffer) => { this.stderr = `${this.stderr}${data.toString()}`.slice(-8_000); });
    child.on('error', (error) => this.handleExit(error));
    child.on('close', (code) => this.handleExit(new Error(this.stderr.trim() || `Codex app-server exited with ${code}.`)));
    await this.rawRequest('initialize', { clientInfo: { name: 'antigravity_orchestra', title: 'Antigravity Orchestra', version: '1.0.0' } }, 15_000);
    this.write({ method: 'initialized', params: {} });
  }

  private rawRequest(method: string, params: JsonRecord, timeoutMs: number): Promise<JsonRecord> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex app-server ${method} timed out.`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ method, id, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  private write(value: JsonRecord) {
    if (!this.child?.stdin.writable) throw new Error('Codex app-server is not running.');
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private handleData(chunk: string) {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || '';
    for (const line of lines) {
      let value: JsonRecord;
      try { value = JSON.parse(line); } catch { continue; }
      if (Number.isInteger(value.id) && ('result' in value || 'error' in value)) {
        const pending = this.pending.get(value.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(value.id);
        if (value.error) pending.reject(new Error(String(value.error.message || JSON.stringify(value.error))));
        else pending.resolve(value.result || {});
        continue;
      }
      if (Number.isInteger(value.id) && typeof value.method === 'string') {
        this.write({ id: value.id, error: { code: -32601, message: `Orchestra does not support interactive app-server request ${value.method}.` } });
        continue;
      }
      if (typeof value.method === 'string') for (const listener of this.listeners) listener(value.method, value.params || {});
    }
  }

  private handleExit(error: Error) {
    if (!this.child) return;
    this.child = null;
    for (const [id, pending] of this.pending) { clearTimeout(pending.timer); pending.reject(error); this.pending.delete(id); }
  }
}

function codexTurnError(turn: JsonRecord, status: string) {
  const message = turn?.error?.message || turn?.error?.additionalDetails || turn?.error;
  const code = turn?.error?.codexErrorInfo;
  if (message) return `Codex turn ${status}: ${typeof message === 'string' ? message : JSON.stringify(message)}`;
  if (code) return `Codex turn ${status}: ${typeof code === 'string' ? code : JSON.stringify(code)}`;
  return `Codex turn finished with status ${status}.`;
}

function friendlyCommandActivity(command: string) {
  if (/\bgit\b/i.test(command)) return 'Inspecting repository and Git state.';
  if (/\b(test|gradle|npm|pytest|build|cmake)\b/i.test(command)) return 'Running a read-only project diagnostic.';
  if (/\b(rg|Get-ChildItem|Get-Content|find)\b/i.test(command)) return 'Inspecting relevant project files.';
  return 'Running a read-only repository inspection step.';
}

function finite(value: unknown): number | null { const number = Number(value); return Number.isFinite(number) ? number : null; }

export const codexAppServer = new CodexAppServer();
export function closeCodexAppServer() { codexAppServer.close(); }
