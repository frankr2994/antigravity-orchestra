import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSdxlTxt2ImgWorkflow,
  buildSdxlImg2ImgWorkflow,
  buildSdxlInpaintWorkflow,
} from '../dist-server/workflow-loader.js';
import { FORGE_DEPENDENCIES } from '../dist-server/forge-manifest.js';
import { stageGpuForStep } from '../dist-server/gpu-manager.js';

test('buildSdxlTxt2ImgWorkflow correctly parameterizes SDXL graph', () => {
  const workflow = buildSdxlTxt2ImgWorkflow({
    prompt: 'A futuristic cybernetic city at twilight',
    negativePrompt: 'blurry, distorted',
    width: 1024,
    height: 1024,
    steps: 30,
    cfg: 7.5,
    seed: 123456,
    samplerName: 'dpmpp_2m',
    scheduler: 'karras',
    denoise: 1.0,
  });

  assert.equal(workflow['6'].inputs.text, 'A futuristic cybernetic city at twilight');
  assert.match(workflow['7'].inputs.text, /blurry, distorted/);
  assert.equal(workflow['5'].inputs.width, 1024);
  assert.equal(workflow['5'].inputs.height, 1024);
  assert.equal(workflow['3'].inputs.seed, 123456);
  assert.equal(workflow['3'].inputs.steps, 30);
  assert.equal(workflow['3'].inputs.cfg, 7.5);
  assert.equal(workflow['3'].inputs.sampler_name, 'dpmpp_2m');
  assert.equal(workflow['3'].inputs.scheduler, 'karras');
  assert.equal(workflow['3'].inputs.denoise, 1.0);
});

test('buildSdxlImg2ImgWorkflow correctly sets source image and locked denoise for structural revisions', () => {
  const workflow = buildSdxlImg2ImgWorkflow({
    sourceImage: 'parent_v1.png',
    prompt: 'Make the lighting dramatic and add rain',
    denoise: 0.40,
    seed: 999888,
  });

  assert.equal(workflow['1'].inputs.image, 'parent_v1.png');
  assert.equal(workflow['6'].inputs.text, 'Make the lighting dramatic and add rain');
  assert.equal(workflow['3'].inputs.denoise, 0.40);
  assert.equal(workflow['3'].inputs.seed, 999888);
});

test('buildSdxlInpaintWorkflow correctly wires source, mask, and differential diffusion conditioning', () => {
  const workflow = buildSdxlInpaintWorkflow({
    sourceImage: 'car_v1.png',
    maskImage: 'car_mask.png',
    prompt: 'Change car color to crimson red',
    denoise: 0.85,
    seed: 456789,
  });

  assert.equal(workflow['1'].inputs.image, 'car_v1.png');
  assert.equal(workflow['2'].inputs.image, 'car_mask.png');
  assert.equal(workflow['6'].inputs.text, 'Change car color to crimson red');
  assert.equal(workflow['3'].inputs.denoise, 0.85);
  assert.equal(workflow['3'].inputs.seed, 456789);
  assert.ok(workflow['10']); // DifferentialDiffusion node
  assert.ok(workflow['11']); // InpaintModelConditioning node
});

test('FORGE_DEPENDENCIES manifest defines SDXL and Fooocus inpaint patch', () => {
  const sdxl = FORGE_DEPENDENCIES.find((d) => d.id === 'sdxl-juggernaut');
  assert.ok(sdxl, 'SDXL Juggernaut model is defined in manifest');
  assert.match(sdxl.fileName, /juggernautXL/i);

  const fooocus = FORGE_DEPENDENCIES.find((d) => d.id === 'fooocus-inpaint-patch');
  assert.ok(fooocus, 'Fooocus Inpaint patch is defined in manifest');
  assert.match(fooocus.fileName, /inpaint_v26\.fooocus\.patch/);

  const vae = FORGE_DEPENDENCIES.find((d) => d.id === 'sdxl-vae');
  assert.ok(vae, 'SDXL VAE is defined in manifest');
});

test('stageGpuForStep handles pipeline stage transitions without throwing', async () => {
  await assert.doesNotReject(async () => {
    await stageGpuForStep('txt2img');
    await stageGpuForStep('inpaint');
    await stageGpuForStep('vision_review');
    await stageGpuForStep('idle');
  });
});
