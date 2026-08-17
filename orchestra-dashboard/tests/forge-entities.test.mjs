import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSdxlIpAdapterWorkflow,
} from '../dist-server/workflow-loader.js';
import {
  createForgeEntity,
  getForgeEntity,
  listForgeEntities,
  updateForgeEntity,
  deleteForgeEntity,
  addReferenceImageToEntity,
} from '../dist-server/forge-entities.js';
import { FORGE_DEPENDENCIES } from '../dist-server/forge-manifest.js';

test('buildSdxlIpAdapterWorkflow parameterizes reference image, prompt, cfg, and weight', () => {
  const workflow = buildSdxlIpAdapterWorkflow({
    referenceImage: 'character_marcus_front.png',
    prompt: 'cmarcus walking down a busy futuristic street at dusk',
    negativePrompt: 'blurry, bad face, deformed',
    ipAdapterWeight: 0.85,
    ckptName: 'juggernautXL_v9.safetensors',
    seed: 887766,
    steps: 25,
    cfg: 7.0,
  });

  assert.equal(workflow['1'].inputs.image, 'character_marcus_front.png');
  assert.equal(workflow['5'].inputs.weight, 0.85);
  assert.match(workflow['4'].inputs.ckpt_name, /juggernautXL/i);
  assert.equal(workflow['7'].inputs.text, 'cmarcus walking down a busy futuristic street at dusk');
  assert.match(workflow['8'].inputs.text, /blurry/i);
  assert.equal(workflow['9'].inputs.seed, 887766);
  assert.equal(workflow['9'].inputs.steps, 25);
  assert.equal(workflow['9'].inputs.cfg, 7.0);
});

test('ForgeEntity CRUD operations persist entity metadata and reference images', () => {
  const entity = createForgeEntity({
    name: 'Captain Marcus',
    category: 'character',
    description: 'Space captain with short silver hair and blue flight jacket',
    triggerWord: 'cmarcus_captain',
    ipAdapterWeight: 0.8,
  });

  assert.ok(entity.id.startsWith('entity_'));
  assert.equal(entity.name, 'Captain Marcus');
  assert.equal(entity.category, 'character');

  const fetched = getForgeEntity(entity.id);
  assert.ok(fetched);
  assert.equal(fetched.name, 'Captain Marcus');

  const updated = updateForgeEntity(entity.id, { description: 'Updated description' });
  assert.equal(updated.description, 'Updated description');

  // Attach a reference image
  const dummyBuffer = Buffer.from('FAKE_PNG_BINARY_CONTENT');
  const ref = addReferenceImageToEntity(entity.id, dummyBuffer, 'primary', 'marcus_face.png');
  assert.ok(ref.id.startsWith('ref_'));
  assert.ok(ref.imageUrl.includes(entity.id));

  const fetchedWithRef = getForgeEntity(entity.id);
  assert.equal(fetchedWithRef.referenceImages.length, 1);
  assert.equal(fetchedWithRef.referenceImages[0].id, ref.id);

  // List entities
  const all = listForgeEntities();
  assert.ok(all.some((e) => e.id === entity.id));

  // Cleanup
  const deleted = deleteForgeEntity(entity.id);
  assert.equal(deleted, true);
  assert.equal(getForgeEntity(entity.id), null);
});

test('FORGE_DEPENDENCIES defines SDXL IP-Adapter and CLIP Vision weights', () => {
  const ipAdapter = FORGE_DEPENDENCIES.find((d) => d.id === 'sdxl-ipadapter');
  assert.ok(ipAdapter, 'SDXL IP-Adapter model is in manifest');
  assert.match(ipAdapter.fileName, /ip-adapter/i);

  const clipVision = FORGE_DEPENDENCIES.find((d) => d.id === 'clip-vision-vit-h');
  assert.ok(clipVision, 'CLIP Vision model is in manifest');
  assert.match(clipVision.fileName, /clip_vision/i);
});
