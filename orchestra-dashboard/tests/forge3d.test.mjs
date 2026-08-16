import test from 'node:test';
import assert from 'node:assert/strict';
import { findComfyInstallation, getComfyStatus } from '../dist-server/comfy.js';
import { requestGemmaVisionReview, runForge3DJob } from '../dist-server/forge3d.js';

test('ComfyUI installation discovery resolves candidate directories dynamically', () => {
  const installation = findComfyInstallation();
  if (installation) {
    assert.ok(installation.rootPath, 'Must identify a valid rootPath');
    assert.ok(installation.pythonPath, 'Must identify python executable');
    assert.ok(installation.modelsDir, 'Must locate models directory');
  }
});

test('getComfyStatus fails truthfully when connecting to an invalid endpoint', async () => {
  const status = await getComfyStatus('http://127.0.0.1:59999');
  assert.equal(status.available, false);
  assert.equal(status.tripoReady, false);
  assert.ok(status.error, 'Must include specific error message');
});

test('requestGemmaVisionReview strictly rejects requests without rendered image data', async () => {
  await assert.rejects(
    async () => {
      await requestGemmaVisionReview('Test Prompt', []);
    },
    {
      message: /requires real rendered viewport captures/i,
    }
  );
});

test('runForge3DJob fails truthfully and does not fabricate placeholder geometry when Comfy is unavailable', async () => {
  // Point to a dummy offline port
  process.env.COMFYUI_URL = 'http://127.0.0.1:59999';
  try {
    await assert.rejects(
      async () => {
        await runForge3DJob('Test asset', 'stylized', false);
      },
      {
        message: /ComfyUI is not reachable/i,
      }
    );
  } finally {
    delete process.env.COMFYUI_URL;
  }
});
