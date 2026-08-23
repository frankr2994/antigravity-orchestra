import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getInstalledLmStudioModels,
  parseLmStudioV1Models,
} from '../dist-server/lmstudio.js';

test('LM Studio discovery parses the documented v1 response and loaded_instances', () => {
  const models = parseLmStudioV1Models({
    models: [
      {
        type: 'llm',
        publisher: 'example',
        key: 'example/model',
        display_name: 'Example Model',
        architecture: 'example-arch',
        quantization: { name: 'Q4_K_M', bits_per_weight: 4 },
        size_bytes: 42,
        params_string: '7B',
        loaded_instances: [{ id: 'example/model', config: { context_length: 8192 } }],
        max_context_length: 32768,
        capabilities: { vision: false, trained_for_tool_use: true },
      },
      {
        type: 'embedding',
        publisher: 'example',
        key: 'example/embedding',
        display_name: 'Example Embedding',
        quantization: null,
        size_bytes: 21,
        params_string: null,
        loaded_instances: [],
        max_context_length: 2048,
      },
    ],
  });

  assert.deepEqual(models[0], {
    id: 'example/model',
    displayName: 'Example Model',
    publisher: 'example',
    arch: 'example-arch',
    quantization: 'Q4_K_M',
    state: 'loaded',
    maxContextLength: 32768,
    loadedContextLength: 8192,
    sizeBytes: 42,
    paramsString: '7B',
    type: 'llm',
    capabilities: ['trained_for_tool_use'],
  });
  assert.equal(models[1].state, 'not-loaded');
});

test('LM Studio discovery rejects malformed v1 payloads', () => {
  assert.throws(() => parseLmStudioV1Models({}), /models array/);
  assert.throws(
    () => parseLmStudioV1Models({ models: [{ key: 'missing-instances' }] }),
    /loaded_instances/,
  );
});

test('LM Studio discovery uses official v1 first and accepts an authoritative empty list', async () => {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(String(url));
    return new Response(JSON.stringify({ models: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  assert.deepEqual(await getInstalledLmStudioModels(fetchImpl), []);
  assert.equal(requested.length, 1);
  assert.match(requested[0], /\/api\/v1\/models$/);
});

