import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { probeRipwire } from '../dist-server/ripwire-probe.js';

const root = mkdtempSync(join(tmpdir(), 'orchestra-ripwire-probe-'));
const executable = process.env.RIPWIRE_PATH || 'F:\\Ripwire\\ripwire-0.5.0\\ripwire-0.5.0\\build\\ripwire.exe';

test('probe results preserve genuine findings and typed unavailable/cancelled outcomes', async () => {
  const unavailable = await probeRipwire(root, ['--situ'], { executable: join(root, 'missing-ripwire.exe') });
  assert.equal(unavailable.status, 'unavailable');
  const controller = new AbortController();
  controller.abort();
  const cancelled = await probeRipwire(root, ['--situ'], { executable, signal: controller.signal });
  assert.equal(cancelled.status, 'cancelled');
});

test('probe timeout is typed and retains command identity', async () => {
  const result = await probeRipwire(root, ['--for=timeout probe', '--token-budget=1200'], { executable, timeoutMs: 1 });
  assert.equal(result.status, 'timeout');
  assert.equal(result.args[0], root);
  assert.ok(result.elapsedMs >= 0);
});
