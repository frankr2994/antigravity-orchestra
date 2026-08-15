import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runProcess } from './process.js';

export interface VerificationResult { command: string; code: number; output: string; }

export function verificationFailure(results: VerificationResult[]): string {
  const failed = results.find((item) => item.code !== 0);
  return failed ? `${failed.command}\n${failed.output.slice(-3000)}` : '';
}

export function npmInvocation(args: string[]): { command: string; args: string[] } {
  if (process.platform !== 'win32') return { command: 'npm', args };
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(cli)) return { command: process.execPath, args: [cli, ...args] };
  return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', 'npm.cmd', ...args] };
}

export async function verifyProject(root: string, signal: AbortSignal): Promise<VerificationResult[]> {
  const commands: Array<{ command: string; args: string[]; label: string }> = [];
  const packagePath = join(root, 'package.json');
  if (existsSync(packagePath)) {
    try {
      const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as { scripts?: Record<string, string> };
      if (pkg.scripts?.lint) commands.push({ ...npmInvocation(['run', 'lint']), label: 'npm run lint' });
      if (pkg.scripts?.build) commands.push({ ...npmInvocation(['run', 'build']), label: 'npm run build' });
      if (pkg.scripts?.test && !/no test specified/i.test(pkg.scripts.test)) commands.push({ ...npmInvocation(['test']), label: 'npm test' });
    } catch { /* malformed package is reported by the agent/build */ }
  } else if (existsSync(join(root, 'pyproject.toml')) || existsSync(join(root, 'pytest.ini'))) {
    commands.push({ command: process.platform === 'win32' ? 'python.exe' : 'python3', args: ['-m', 'pytest'], label: 'python -m pytest' });
  }
  const results: VerificationResult[] = [];
  for (const item of commands) {
    const result = await runProcess(item.command, item.args, { cwd: root, timeoutMs: 10 * 60_000, signal });
    results.push({ command: item.label, code: result.code, output: `${result.stdout}\n${result.stderr}`.trim().slice(-12_000) });
    if (result.code !== 0) break;
  }
  return results;
}
