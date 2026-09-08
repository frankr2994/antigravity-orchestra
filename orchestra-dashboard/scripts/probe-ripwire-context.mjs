// Local, model-free Ripwire integration diagnostics. Does not modify the target repository.
// Usage: node scripts/probe-ripwire-context.mjs --exe <ripwire.exe> [--root <repo>] [--out <report.json>]
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!['--exe', '--root', '--out'].includes(key) || !process.argv[i + 1]) {
    throw new Error('Usage: --exe <ripwire.exe> [--root <repo>] [--out <report.json>]');
  }
  options.set(key, process.argv[i + 1]);
}
const exe = options.get('--exe') || process.env.RIPWIRE_PATH;
if (!exe) throw new Error('Supply --exe or RIPWIRE_PATH.');
const scratch = mkdtempSync(join(tmpdir(), 'orchestra-ripwire-probe-'));
const fixture = join(scratch, 'fixture');
mkdirSync(join(fixture, 'src'), { recursive: true });
mkdirSync(join(fixture, 'ignored_extra'), { recursive: true });
mkdirSync(join(fixture, 'nested', 'dist-server'), { recursive: true });
const original = 'export function demo(value: number) {\n  return value + 1;\n}\n';
writeFileSync(join(fixture, '.gitignore'), 'ignored_extra/\n');
writeFileSync(join(fixture, 'nested', '.gitignore'), 'dist-server/\n');
writeFileSync(join(fixture, 'src', 'demo.ts'), original);
for (const directory of ['ignored_extra', 'nested/dist-server']) {
  writeFileSync(join(fixture, directory, 'demo.ts'), original);
}
function processResult(command, args, cwd) {
  const start = performance.now();
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 4_000_000,
  });
  return { ...result, durationMs: Math.round(performance.now() - start) };
}
for (const args of [
  ['init', '--quiet'], ['add', '.'],
  ['-c', 'core.hooksPath=' + join(scratch, 'no-hooks'), '-c', 'commit.gpgSign=false',
    '-c', 'user.name=Orchestra fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'Local diagnostic fixture'],
]) {
  const result = processResult('git', args, fixture);
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'Fixture Git failed');
}
writeFileSync(join(fixture, 'src', 'demo.ts'), original.replace('value + 1', 'value + 2'));
const version = processResult(exe, ['--version'], fixture);
const probes = [];
function probe(name, args, { cwd = fixture, root = '.', cache = 'shared' } = {}) {
  const result = processResult(exe, [root, ...args, '--cache=' + join(scratch, cache + '.bin')], cwd);
  const output = result.stdout || '';
  // Keep metrics and root attributes, not target source bodies or full context bundles.
  const tags = [...output.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<(?:ctx|skipped|test-gate|quality-delta)\b[^>]*>/g)].map(m => m[0]);
  const record = {
    name, args, code: result.status, durationMs: result.durationMs,
    bytes: Buffer.byteLength(output), estimatedTokens: Number(output.match(/est_tokens=["']?(\d+)/)?.[1]) || null,
    tags, stderr: result.stderr || '', error: result.error?.message || null,
    cacheRejected: /parser-version|parserVer mismatch/.test(result.stderr || ''),
  };
  probes.push(record);
  return { record, output };
}
const ignored = probe('git-ignore-contract', ['--skipped'], { cache: 'ignore' });
const automatic = probe('automatic-test-gate', ['--test-gate'], { cache: 'gate' });
probe('automatic-situ', ['--situ'], { cache: 'situ' });
const forward = probe('forward-slash-selector', ['--expand=src/demo.ts:demo'], { cache: 'lean' });
const native = probe('native-selector', ['--expand=.\\src\\demo.ts:demo'], { cache: 'lean' });
probe('native-selector-forced-payload', ['--expand=.\\src\\demo.ts:demo', '--top-k=0'], { cache: 'lean' });
probe('task-map-wrong-budget-option', ['--for=demo', '--max-tokens=2000'], { cache: 'rich' });
probe('task-map-supported-budget', ['--for=demo', '--token-budget=2000'], { cache: 'rich' });
probe('shared-cache-rich', ['--for=demo', '--token-budget=2000']);
probe('shared-cache-lean', ['--expand=.\\src\\demo.ts:demo']);
probe('shared-cache-rich-again', ['--for=demo', '--token-budget=2000']);
probe('separate-cache-rich-again', ['--for=demo', '--token-budget=2000'], { cache: 'rich' });
probe('separate-cache-lean-again', ['--expand=.\\src\\demo.ts:demo'], { cache: 'lean' });
if (options.has('--root')) {
  const root = resolve(options.get('--root'));
  // Same repository, same question, sequential calls, separate caches by crawl mode.
  for (const [name, args, cache] of [
    ['repository-current-options', ['--for=Codex review repair context', '--max-tokens=2000', '--no-ignore'], 'repo-current'],
    ['repository-supported-budget', ['--for=Codex review repair context', '--token-budget=2000'], 'repo-budget'],
    ['repository-supported-budget-warm', ['--for=Codex review repair context', '--token-budget=2000'], 'repo-budget'],
  ]) probe(name, args, { cwd: root, root: '.', cache });
}
const checks = {
  gitIgnoreApplied: /ignored_dirs="2"/.test(ignored.output),
  changedTrackedFileDetected: /changed="1"/.test(automatic.output),
  forwardSlashSelectorWorks: forward.record.code === 0 && /value \+ 2/.test(forward.output),
  nativeSelectorWorks: native.record.code === 0 && /value \+ 2/.test(native.output),
};
const report = { at: new Date().toISOString(), version: version.stdout?.trim(), scratch, checks, probes };
if (options.has('--out')) {
  const output = resolve(options.get('--out'));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ version: report.version, checks, scratch,
  probes: probes.map(({ name, code, durationMs, bytes, estimatedTokens, cacheRejected }) =>
    ({ name, code, durationMs, bytes, estimatedTokens, cacheRejected })) }, null, 2));
// Nonzero signals a compatibility failure, not a test suite or model review failure.
if (Object.values(checks).some(value => !value)) process.exitCode = 1;
