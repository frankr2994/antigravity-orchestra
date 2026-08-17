import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLtxImg2VidWorkflow,
  buildWanTxt2VidWorkflow,
  buildWanImg2VidWorkflow,
} from '../dist-server/workflow-loader.js';
import { FORGE_DEPENDENCIES } from '../dist-server/forge-manifest.js';

test('buildLtxImg2VidWorkflow parameterizes input image, prompt, fps, and denoise for LTX-Video', () => {
  const workflow = buildLtxImg2VidWorkflow({
    sourceImage: 'character_pose_v1.png',
    prompt: 'cinematic pan around the character with natural lighting shift',
    negativePrompt: 'jitter, distortion, morphing',
    fps: 24,
    steps: 20,
    cfg: 3.0,
    seed: 554433,
    denoise: 1.0,
  });

  assert.equal(workflow['1'].inputs.image, 'character_pose_v1.png');
  assert.match(workflow['2'].inputs.ckpt_name, /ltx-video/i);
  assert.equal(workflow['4'].inputs.text, 'cinematic pan around the character with natural lighting shift');
  assert.equal(workflow['5'].inputs.text, 'jitter, distortion, morphing');
  assert.equal(workflow['6'].inputs.seed, 554433);
  assert.equal(workflow['6'].inputs.steps, 20);
  assert.equal(workflow['6'].inputs.cfg, 3.0);
  assert.equal(workflow['6'].inputs.denoise, 1.0);
  assert.equal(workflow['8'].inputs.fps, 24);
});

test('buildWanTxt2VidWorkflow parameterizes text-to-video dimensions, length, and sampler', () => {
  const workflow = buildWanTxt2VidWorkflow({
    prompt: 'A sleek sports car accelerating on an empty neon highway at dusk',
    negativePrompt: 'bad quality, glitch, warp',
    width: 832,
    height: 480,
    length: 81,
    steps: 25,
    cfg: 6.0,
    seed: 778899,
    fps: 16,
  });

  assert.match(workflow['1'].inputs.ckpt_name, /wan2\.1_t2v/i);
  assert.equal(workflow['2'].inputs.width, 832);
  assert.equal(workflow['2'].inputs.height, 480);
  assert.equal(workflow['2'].inputs.length, 81);
  assert.equal(workflow['3'].inputs.text, 'A sleek sports car accelerating on an empty neon highway at dusk');
  assert.equal(workflow['4'].inputs.text, 'bad quality, glitch, warp');
  assert.equal(workflow['5'].inputs.seed, 778899);
  assert.equal(workflow['5'].inputs.steps, 25);
  assert.equal(workflow['5'].inputs.cfg, 6.0);
  assert.equal(workflow['7'].inputs.fps, 16);
});

test('buildWanImg2VidWorkflow parameterizes image-to-video source and prompts', () => {
  const workflow = buildWanImg2VidWorkflow({
    sourceImage: 'scene_keyframe.png',
    prompt: 'smooth camera drone pull back showing surrounding forest',
    steps: 25,
    cfg: 6.0,
    seed: 112233,
    fps: 16,
  });

  assert.equal(workflow['1'].inputs.image, 'scene_keyframe.png');
  assert.match(workflow['2'].inputs.ckpt_name, /wan2\.1_i2v/i);
  assert.equal(workflow['4'].inputs.text, 'smooth camera drone pull back showing surrounding forest');
  assert.equal(workflow['6'].inputs.seed, 112233);
  assert.equal(workflow['8'].inputs.fps, 16);
});

test('FORGE_DEPENDENCIES defines LTX-Video 2B and Wan 2.1 video checkpoints', () => {
  const ltx = FORGE_DEPENDENCIES.find((d) => d.id === 'ltx-video-2b');
  assert.ok(ltx, 'LTX-Video 2B distilled model is in manifest');
  assert.match(ltx.fileName, /ltx-video-2b/i);

  const wan = FORGE_DEPENDENCIES.find((d) => d.id === 'wan21-t2v-13b');
  assert.ok(wan, 'Wan 2.1 1.3B checkpoint is in manifest');
  assert.match(wan.fileName, /wan2\.1_t2v/i);
});
