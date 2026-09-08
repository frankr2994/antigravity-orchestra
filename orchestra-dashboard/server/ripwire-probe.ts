import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export type ProbeStatus = 'ok' | 'findings' | 'partial' | 'unavailable' | 'failed' | 'timeout' | 'cancelled';
export interface ProbeResult {
  status: ProbeStatus;
  output: string;
  stderr: string;
  exitCode: number | null;
  executable: { path: string; sha256: string | null };
  args: string[];
  elapsedMs: number;
  rawArtifact?: string;
  cacheFamily: 'lean' | 'rich';
  coverage: { state: 'unknown' | 'complete' | 'partial'; omissions: Array<{ path: string; reason: string }> };
}

// Keep this predicate pinned to cli.h::needsValueUses. PR context is lean.
export function ripwireCacheFamily(args: readonly string[]): 'lean' | 'rich' {
  return args.some(arg => /^(--for=|--metrics(?:=|$)|--uses(?:=|$)|--exemplar(?:=|$))/.test(arg)) ? 'rich' : 'lean';
}

const queues = new Map<string, Promise<unknown>>();
const pending = new Map<string, Promise<ProbeResult>>();
const signals = new WeakMap<AbortSignal, number>();
let nextSignal = 0;
const hash = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

export function probeRipwire(root: string, args: string[], options: {
  signal?: AbortSignal; timeoutMs?: number; acceptedExitCodes?: readonly number[]; executable?: string;
} = {}): Promise<ProbeResult> {
  const executable = options.executable || process.env.RIPWIRE_PATH || 'F:\\Ripwire\\ripwire-0.5.0\\ripwire-0.5.0\\build\\ripwire.exe';
  const family = ripwireCacheFamily(args);
  const base: ProbeResult = { status: 'failed', output: '', stderr: '', exitCode: null, executable: { path: executable, sha256: null },
    args: [root, ...args], elapsedMs: 0, cacheFamily: family, coverage: { state: 'unknown', omissions: [] } };
  if (options.signal?.aborted) return Promise.resolve({ ...base, status: 'cancelled', stderr: 'Cancelled before launch.' });
  let canonical: string;
  try { base.executable.sha256 = hash(readFileSync(executable)); canonical = realpathSync.native(root); }
  catch (error) { return Promise.resolve({ ...base, status: 'unavailable', stderr: String(error) }); }
  const directory = join(process.env.RIPWIRE_CACHE_DIR || join(tmpdir(), 'orchestra-ripwire-cache'), hash(canonical + base.executable.sha256));
  try { mkdirSync(directory, { recursive: true }); }
  catch (error) { return Promise.resolve({ ...base, stderr: `Cache unavailable: ${String(error)}` }); }
  base.args.push(`--cache=${join(directory, `${family}.ripwirecache`)}`);
  if (options.signal && !signals.has(options.signal)) signals.set(options.signal, ++nextSignal);
  const queueKey = `${directory}/${family}`;
  const key = JSON.stringify([queueKey, args, options.timeoutMs, options.acceptedExitCodes, options.signal ? signals.get(options.signal) : null]);
  const existing = pending.get(key);
  if (existing) return existing;
  const run = (queues.get(queueKey) || Promise.resolve()).catch(() => {}).then(async () => {
    if (options.signal?.aborted) return { ...base, status: 'cancelled' as const, stderr: 'Cancelled while queued.' };
    const result = await executeProbe(base, canonical, options);
    const rawArtifact = join(directory, `${hash(JSON.stringify([result.args, result.output, result.stderr]))}.json`);
    try { writeFileSync(rawArtifact, JSON.stringify(result), { flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') result.stderr += `\nArtifact write failed: ${String(error)}`; }
    result.rawArtifact = rawArtifact;
    return result;
  });
  queues.set(queueKey, run); pending.set(key, run);
  void run.finally(() => { if (queues.get(queueKey) === run) queues.delete(queueKey); pending.delete(key); });
  return run;
}

function executeProbe(base: ProbeResult, cwd: string, options: { signal?: AbortSignal; timeoutMs?: number; acceptedExitCodes?: readonly number[] }): Promise<ProbeResult> {
  return new Promise(resolve => {
    const started = performance.now();
    const child = spawn(base.executable.path, base.args, { cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let stderr = ''; let requested: 'timeout' | 'cancelled' | undefined;
    let spawnError = false;
    const stop = (reason: 'timeout' | 'cancelled') => {
      requested ||= reason;
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', error => { stderr += `\nTermination failed: ${error.message}`; child.kill(); });
      } else child.kill('SIGKILL');
    };
    const abort = () => stop('cancelled');
    const timer = setTimeout(() => stop('timeout'), options.timeoutMs ?? 60_000);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { spawnError = true; stderr += error.message; });
    // Resolve cancellation only after the child has actually closed, retaining complete output.
    child.on('close', code => {
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      let status: ProbeStatus = requested || (spawnError || code === null || !(options.acceptedExitCodes || [0]).includes(code) ? 'failed' : code === 0 ? 'ok' : 'findings');
      if (status === 'ok' && /incomplete coverage|cannot derive|unspelled|AMBIGUOUS/i.test(stderr)) status = 'partial';
      resolve({ ...base, status, output, stderr, exitCode: code, elapsedMs: Math.round(performance.now() - started) });
    });
  });
}
