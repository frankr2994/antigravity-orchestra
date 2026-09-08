import test from 'node:test';
import assert from 'node:assert/strict';
import { senseEnvironment } from '../dist-server/application/capabilities/environment-sensor.js';
import { closeCodexAppServer } from '../dist-server/codex-app-server.js';

test('EnvironmentSensor — senses environment without hardcoded assumptions and fails open', async () => {
  try {
    const capabilities = await senseEnvironment({});

    assert.ok(capabilities);
    assert.ok(typeof capabilities.gemma === 'object');
    assert.ok(typeof capabilities.codex === 'object');
    assert.ok(typeof capabilities.antigravity === 'object');
    assert.ok(typeof capabilities.jules === 'object');
    assert.ok(typeof capabilities.mcp === 'object');

    // Antigravity models should resolve to array
    assert.ok(Array.isArray(capabilities.antigravity.models));
    assert.ok(capabilities.antigravity.models.length > 0);

    // Codex models should include standard family
    assert.ok(Array.isArray(capabilities.codex.models));
    assert.ok(capabilities.codex.models.includes('gpt-5.6-terra'));
    assert.ok(capabilities.codex.models.includes('gpt-5.6-luna'));
    assert.ok(capabilities.codex.models.includes('gpt-5.6-sol'));
  } finally {
    closeCodexAppServer();
  }
});
