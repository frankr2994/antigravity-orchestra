import test from 'node:test';
import assert from 'node:assert/strict';
import { findComfyInstallation, getComfyStatus } from '../dist-server/comfy.js';
import { requestGemmaVisionReview, runForge3DJob } from '../dist-server/forge3d.js';
import { checkForgeDependencies, FORGE_DEPENDENCIES, getDownloadProgress } from '../dist-server/forge-manifest.js';
import { buildConceptGenerationWorkflow, buildTripoSRWorkflow } from '../dist-server/workflow-loader.js';
import { freeComfyMemory } from '../dist-server/gpu-manager.js';
import { sanitizeAndExportGlb } from '../dist-server/mesh-qa.js';

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

test('FORGE_DEPENDENCIES manifest defines complete download metadata', () => {
  assert.ok(FORGE_DEPENDENCIES.length >= 2, 'Manifest must contain core models');
  for (const dep of FORGE_DEPENDENCIES) {
    assert.ok(dep.id, 'Must have id');
    assert.ok(dep.name, 'Must have name');
    assert.ok(dep.targetSubdir, 'Must specify targetSubdir');
    assert.ok(dep.downloadUrl.startsWith('https://'), 'Must specify HTTPS download URL');
  }
});

test('checkForgeDependencies returns structured readiness and dependency statuses', async () => {
  const setup = await checkForgeDependencies();
  assert.equal(typeof setup.comfyFound, 'boolean');
  assert.equal(typeof setup.missingCount, 'number');
  assert.ok(Array.isArray(setup.items));
  assert.ok(setup.items.length >= 2);
});

test('getDownloadProgress returns null when idle', () => {
  assert.equal(getDownloadProgress(), null);
});

test('buildConceptGenerationWorkflow parameterizes JSON template nodes properly', () => {
  const wf = buildConceptGenerationWorkflow({
    prompt: 'Dwarven Battleaxe',
    steps: 25,
    cfg: 8.0,
    seed: 42,
  });
  assert.ok(wf['6'].inputs.text.includes('Dwarven Battleaxe'));
  assert.equal(wf['3'].inputs.steps, 25);
  assert.equal(wf['3'].inputs.cfg, 8.0);
  assert.equal(wf['3'].inputs.seed, 42);
});

test('buildTripoSRWorkflow injects image name and geometry resolution', () => {
  const wf = buildTripoSRWorkflow({
    imageName: 'test_render.png',
    geometryResolution: 512,
    threshold: 30.0,
  });
  assert.equal(wf['15'].inputs.image, 'test_render.png');
  assert.equal(wf['12'].inputs.geometry_resolution, 512);
  assert.equal(wf['12'].inputs.threshold, 30.0);
});

test('freeComfyMemory handles unreachable endpoint gracefully', async () => {
  const result = await freeComfyMemory('http://127.0.0.1:59999');
  assert.equal(result, false);
});

test('sanitizeAndExportGlb throws an error if input file does not exist', async () => {
  await assert.rejects(
    async () => {
      await sanitizeAndExportGlb('F:/non_existent_file.obj', 'F:/output.glb');
    },
    {
      message: /does not exist/i,
    }
  );
});
