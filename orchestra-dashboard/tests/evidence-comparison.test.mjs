import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildEvidencePacket, captureEvidenceSnapshot } from '../dist-server/evidence-snapshot.js';

function state({ files = [], configuration = {} } = {}) {
  return {
    reviewBase: 'base-sha',
    head: 'head-sha',
    indexState: files.map(file => `${file.path}:${file.index || ' '}:${file.worktree || ' '}`).join('|'),
    trackedChanges: files,
    untrackedContent: [],
    analysisConfiguration: { packetVersion: 1, ...configuration },
  };
}

function recordsFor(scenario) {
  const records = [
    { id: 'acceptance', kind: 'acceptance', queryIdentity: 'request', provenance: { source: 'request' }, content: `Acceptance for ${scenario}` },
    { id: 'manifest', kind: 'manifest', queryIdentity: 'git-status', provenance: { source: 'git' }, content: `manifest:${scenario}` },
    { id: 'diff', kind: 'diff', queryIdentity: 'base-sha', provenance: { source: 'git diff', baseline: 'base-sha' }, content: `diff --git a/${scenario}.ts b/${scenario}.ts\n@@ -1 +1 @@\n-old\n+new:${scenario}` },
  ];
  if (scenario === 'multi-file') records.push({ id: 'diff-2', kind: 'diff', queryIdentity: 'base-sha:second', provenance: { source: 'git diff', baseline: 'base-sha' }, content: 'second-file-change' });
  if (scenario === 'deletion-rename') records.push({ id: 'historical-source', kind: 'source', queryIdentity: 'base-sha:old.ts', provenance: { source: 'Git historical source', baseline: 'base-sha' }, content: 'old implementation' });
  if (scenario === 'configuration') records.push({ id: 'configuration', kind: 'verification', queryIdentity: 'config', provenance: { source: 'verification' }, content: 'configuration changed' });
  if (scenario === 'generated-noise') records.push({ id: 'generated-report', kind: 'report', queryIdentity: 'generated', provenance: { source: 'generated artifact' }, content: 'generated output remains retrievable' });
  return records;
}

test('offline comparison covers change shapes, complete-record packets, and repair reuse', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestra-evidence-comparison-'));
  const scenarios = [
    ['small-fix', state({ files: [{ path: 'small-fix.ts', index: ' ', worktree: 'M' }] })],
    ['multi-file', state({ files: [{ path: 'one.ts', index: ' ', worktree: 'M' }, { path: 'two.ts', index: ' ', worktree: 'M' }] })],
    ['deletion-rename', state({ files: [{ path: 'old.ts', index: 'D', worktree: ' ' }, { path: 'new.ts', index: 'A', worktree: ' ' }] })],
    ['configuration', state({ files: [{ path: 'config.json', index: ' ', worktree: 'M' }], configuration: { parser: 'v2' } })],
    ['generated-noise', state({ files: [{ path: 'src.ts', index: ' ', worktree: 'M' }], configuration: { generatedFiles: 'omitted-from-packet' } })],
  ];

  for (const [name, reviewState] of scenarios) {
    const records = recordsFor(name);
    const snapshot = await captureEvidenceSnapshot({ root, taskId: `comparison-${name}`, state: reviewState, now: '2026-01-01T00:00:00.000Z', records,
      coverage: name === 'deletion-rename' ? { state: 'partial', indexedPaths: ['new.ts'], omissions: [{ path: 'old.ts', reason: 'historical impact unknown' }] } : undefined });
    const packet = buildEvidencePacket(snapshot, name === 'multi-file' ? 320 : 2_000);
    assert.equal(packet.includedRecordIds.length + packet.omittedRecordIds.length, records.length, `${name}: every record is accounted for`);
    for (const record of snapshot.records.filter(record => packet.includedRecordIds.includes(record.id))) {
      assert.ok(packet.text.includes(record.content), `${name}: included records remain whole`);
    }
    for (const omission of packet.omissions) assert.match(packet.text, new RegExp(omission.retrieval.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const legacyPacket = records.map(record => record.content).join('\n');
    assert.ok(packet.estimatedTokens <= Math.ceil(Buffer.byteLength(`${legacyPacket}\n${snapshot.coverage.omissions.map(item => item.reason).join('\n')}`, 'utf8') / 4) + 120, `${name}: packet remains compact without losing evidence accounting`);
  }

  const first = await captureEvidenceSnapshot({ root, taskId: 'comparison-repair', state: state({ files: [{ path: 'repair.ts', index: ' ', worktree: 'M' }] }), now: '2026-01-01T00:00:00.000Z', records: recordsFor('small-fix') });
  const retry = await captureEvidenceSnapshot({ root, taskId: 'comparison-repair', state: state({ files: [{ path: 'repair.ts', index: ' ', worktree: 'M' }] }), now: '2026-01-02T00:00:00.000Z', records: recordsFor('small-fix') });
  const repaired = await captureEvidenceSnapshot({ root, taskId: 'comparison-repair', state: state({ files: [{ path: 'repair.ts', index: ' ', worktree: 'M' }], configuration: { repairCycle: 2 } }), now: '2026-01-03T00:00:00.000Z', records: recordsFor('small-fix') });
  assert.equal(first.snapshotId, retry.snapshotId, 'unchanged repair state reuses deterministic evidence');
  assert.notEqual(first.snapshotId, repaired.snapshotId, 'configuration/content mutation invalidates reuse');
});
