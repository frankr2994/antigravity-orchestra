import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  isRipwireAvailable,
  runRipwireFor,
  runRipwireQualityDelta,
  runRipwireSitu,
  runRipwireTestGate,
} from '../dist-server/ripwire.js';

function createFixture() {
  const scratch = mkdtempSync(join(tmpdir(), 'orchestra-ripwire-test-'));
  const root = join(scratch, 'repo');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'ignored'), { recursive: true });
  writeFileSync(join(root, '.gitignore'), 'ignored/\n');
  writeFileSync(join(root, 'src', 'demo.ts'), 'export function demo(value: number) { return value + 1; }\n');
  writeFileSync(join(root, 'ignored', 'demo.ts'), 'export function ignored(value: number) { return value + 9; }\n');
  const git = (...args) => {
    const result = spawnSync('git.exe', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`);
  };
  git('init', '--quiet');
  git('config', 'user.email', 'orchestra-ripwire-test@example.invalid');
  git('config', 'user.name', 'Orchestra Ripwire Test');
  git('add', '.gitignore', 'src/demo.ts');
  git('commit', '--quiet', '-m', 'fixture');
  writeFileSync(join(root, 'src', 'demo.ts'), 'export function demo(value: number) { return value + 2; }\n');
  return root;
}

test('Ripwire wrapper uses bounded verbs, preserves findings, and separates cache families', { skip: !isRipwireAvailable() }, async () => {
  const root = createFixture();

  const task = await runRipwireFor(root, 'review the demo change', 1_200);
  assert.ok(task, 'task map should be available');
  assert.match(task.command, /--token-budget=1200/);
  assert.doesNotMatch(task.command, /--max-tokens/);
  assert.doesNotMatch(task.output, /<!--/, 'XML schema legends should not enter the review context');
  assert.equal(task.status, 'ok');

  const situ = await runRipwireSitu(root, undefined, ['.\\src\\demo.ts']);
  assert.ok(situ, 'situational report should be available');
  assert.match(situ.output, /1 changed file\(s\)/);

  const gate = await runRipwireTestGate(root, undefined, ['src/demo.ts']);
  assert.ok(gate, 'test-gate report should be preserved even when obligations produce exit 4');
  assert.ok([0, 4].includes(gate.exitCode));
  assert.equal(gate.status, gate.exitCode === 0 ? 'ok' : 'findings');
  assert.doesNotMatch(gate.output, /<!--/);
  assert.match(gate.output, /changed="1"/);

  const quality = await runRipwireQualityDelta(root);
  assert.ok(quality, 'quality-delta report should be preserved even when findings produce exit 2');
  assert.ok([0, 2].includes(quality.exitCode));
  assert.equal(quality.status, quality.exitCode === 0 ? 'ok' : 'findings');
  assert.doesNotMatch(quality.output, /<!--/);

  const richAgain = await runRipwireFor(root, 'review the demo change', 1_200);
  assert.ok(richAgain);
  const diagnostics = [task.stderr, situ.stderr, gate.stderr, quality.stderr, richAgain.stderr].filter(Boolean).join('\n');
  assert.doesNotMatch(diagnostics, /parser-version|parserVer mismatch/i, 'lean/rich cache families must not invalidate each other');
});
