import test from 'node:test';
import assert from 'node:assert/strict';
import { findComfyInstallation, getComfyStatus } from '../dist-server/comfy.js';
import { probeLmStudioStatus, repairForgeAsset, requestGemmaVisionReview, reviewForgeAsset, runForge3DJob } from '../dist-server/forge3d.js';
import { checkForgeDependencies, FORGE_DEPENDENCIES, getDownloadProgress, probePythonPackages } from '../dist-server/forge-manifest.js';
import { buildConceptGenerationWorkflow, buildTripoSRWorkflow } from '../dist-server/workflow-loader.js';
import { freeComfyMemory } from '../dist-server/gpu-manager.js';
import { exportModelFormat, sanitizeAndExportGlb } from '../dist-server/mesh-qa.js';
import { preprocessImageForTripo } from '../dist-server/rembg-processor.js';

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

test('probeLmStudioStatus returns structured availability and multimodal capability', async () => {
  const status = await probeLmStudioStatus();
  assert.equal(typeof status.available, 'boolean');
  assert.equal(typeof status.model, 'string');
  assert.equal(typeof status.isMultimodal, 'boolean');
});

test('probePythonPackages returns boolean without throwing on valid or invalid packages', async () => {
  const installation = findComfyInstallation();
  const pyPath = installation?.pythonPath || (process.platform === 'win32' ? 'python.exe' : 'python3');
  const result = await probePythonPackages(pyPath, ['sys', 'os']);
  assert.equal(typeof result, 'boolean');
  const fakePkgResult = await probePythonPackages(pyPath, ['non_existent_fake_package_xyz']);
  assert.equal(fakePkgResult, false);
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

test('reviewForgeAsset throws error if asset does not exist', async () => {
  await assert.rejects(
    async () => {
      await reviewForgeAsset('non_existent_id', ['fake_b64']);
    },
    {
      message: /Asset not found with ID/i,
    }
  );
});

test('repairForgeAsset throws error if asset does not exist', async () => {
  await assert.rejects(
    async () => {
      await repairForgeAsset('non_existent_id');
    },
    {
      message: /Asset not found with ID/i,
    }
  );
});

test('exportModelFormat throws error if input model does not exist', async () => {
  await assert.rejects(
    async () => {
      await exportModelFormat('F:/non_existent.glb', 'obj', 'F:/output.obj');
    },
    {
      message: /does not exist/i,
    }
  );
});

test('preprocessImageForTripo throws error if source image does not exist', async () => {
  await assert.rejects(
    async () => {
      await preprocessImageForTripo('F:/non_existent_source.png', 'F:/output.png');
    },
    {
      message: /does not exist/i,
    }
  );
});

test('runForge3DJob fails truthfully and does not fabricate placeholder geometry when Comfy is unavailable', async () => {
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

test('FORGE_DEPENDENCIES manifest defines complete download metadata and marks rembg & u2net.onnx as required', () => {
  assert.ok(FORGE_DEPENDENCIES.length >= 4, 'Manifest must contain core models, rembg package, and u2net.onnx model');
  const rembgDep = FORGE_DEPENDENCIES.find((d) => d.id === 'rembg-pkg');
  assert.ok(rembgDep, 'Manifest must include rembg-pkg');
  assert.equal(rembgDep?.required, true, 'rembg-pkg must be marked as a required dependency');

  const u2netDep = FORGE_DEPENDENCIES.find((d) => d.id === 'rembg-model');
  assert.ok(u2netDep, 'Manifest must include rembg-model');
  assert.equal(u2netDep?.required, true, 'rembg-model must be marked as a required dependency');
  assert.equal(u2netDep?.fileName, 'u2net.onnx');

  for (const dep of FORGE_DEPENDENCIES) {
    assert.ok(dep.id, 'Must have id');
    assert.ok(dep.name, 'Must have name');
    assert.ok(dep.targetSubdir !== undefined, 'Must specify targetSubdir');
    assert.ok(dep.downloadUrl, 'Must specify download URL');
  }
});

test('checkForgeDependencies returns structured readiness and dependency statuses with dynamic non-sticky restart', async () => {
  const setup = await checkForgeDependencies();
  assert.equal(typeof setup.comfyFound, 'boolean');
  assert.equal(typeof setup.missingCount, 'number');
  assert.equal(typeof setup.restartRequired, 'boolean');
  assert.ok(Array.isArray(setup.items));
  assert.ok(setup.items.length >= 4);
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

test('buildTripoSRWorkflow supports progressive resolution escalation from 256 to 384 to 512', () => {
  const wf256 = buildTripoSRWorkflow({ imageName: 'test.png', geometryResolution: 256, threshold: 25.0 });
  assert.equal(wf256['12'].inputs.geometry_resolution, 256);
  assert.equal(wf256['12'].inputs.threshold, 25.0);

  const wf384 = buildTripoSRWorkflow({ imageName: 'test.png', geometryResolution: 384, threshold: 28.0 });
  assert.equal(wf384['12'].inputs.geometry_resolution, 384);
  assert.equal(wf384['12'].inputs.threshold, 28.0);

  const wf512 = buildTripoSRWorkflow({ imageName: 'test.png', geometryResolution: 512, threshold: 30.0 });
  assert.equal(wf512['12'].inputs.geometry_resolution, 512);
  assert.equal(wf512['12'].inputs.threshold, 30.0);
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
