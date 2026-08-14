import { spawn } from 'node:child_process';

export interface ProcessResult { code: number; stdout: string; stderr: string; }
export class ProcessTimeoutError extends Error {
  constructor(public readonly timeoutMs: number, public readonly stdout: string, public readonly stderr: string) {
    super(`Process timed out after ${timeoutMs}ms`);
    this.name = 'ProcessTimeoutError';
  }
}
export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export function runProcess(command: string, args: string[], options: RunOptions = {}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = ''; let settled = false;
    const finish = (error?: Error, code = -1) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve({ code, stdout, stderr });
    };
    const abort = () => { terminateTree(child.pid); finish(new Error('Process cancelled')); };
    const timer = options.timeoutMs ? setTimeout(() => { terminateTree(child.pid); finish(new ProcessTimeoutError(options.timeoutMs!, stdout, stderr)); }, options.timeoutMs) : undefined;
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (data: Buffer) => { const chunk = data.toString(); stdout += chunk; options.onStdout?.(chunk); });
    child.stderr.on('data', (data: Buffer) => { const chunk = data.toString(); stderr += chunk; options.onStderr?.(chunk); });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => finish(undefined, code ?? -1));
    if (options.input !== undefined) child.stdin.end(options.input); else child.stdin.end();
  });
}

export async function commandAvailable(command: string): Promise<boolean> {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  try { return (await runProcess(locator, [command], { timeoutMs: 3000 })).code === 0; } catch { return false; }
}

function terminateTree(pid: number | undefined) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
  } else {
    try { process.kill(-pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
}
