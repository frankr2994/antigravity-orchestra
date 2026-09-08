import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  buildEvidencePacket,
  captureEvidenceSnapshot,
  fingerprintReviewState,
  listEvidenceRecords,
  retrieveDiffHunk,
  retrieveSourceRange,
  EvidenceMutationError,
} from '../dist-server/evidence-snapshot.js';
import { applyReviewerDisposition, loadFindingLedger, updateFindingLedger } from '../dist-server/finding-ledger.js';

function state(changes = []) {
  return { reviewBase: 'base-sha', head: 'head-sha', indexState: changes.join('|'), trackedChanges: changes.map(path => ({ path, status: 'M' })),
    untrackedContent: [], analysisConfiguration: { parser: 'test', version: 1 } };
}

test('snapshot packets are deterministic, complete by record, and retrievable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestra-evidence-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'demo.ts'), 'one\ntwo\nthree\n');
  const input = { root, taskId: 'task/one', state: state(['src/demo.ts']), now: '2026-01-01T00:00:00.000Z', records: [
    { id: 'diff', kind: 'diff', queryIdentity: 'base-sha', provenance: { source: 'git diff' }, content: 'diff --git a/src/demo.ts b/src/demo.ts\n@@ -1 +1 @@\n-one\n+two\n@@ -3 +3 @@\n-three\n+four\n' },
    { id: 'source', kind: 'source', queryIdentity: 'src/demo.ts:1-3', provenance: { source: 'filesystem' }, content: 'one\ntwo\nthree\n' },
  ] };
  const first = await captureEvidenceSnapshot(input);
  const second = await captureEvidenceSnapshot(input);
  assert.equal(first.snapshotId, second.snapshotId);
  const packetA = buildEvidencePacket(first, 250);
  const packetB = buildEvidencePacket(second, 250);
  assert.deepEqual(packetA, packetB);
  assert.ok(packetA.omittedRecordIds.length >= 0);
  assert.equal(listEvidenceRecords(root, 'task/one', first.snapshotId).length, 2);
  const hunk = retrieveDiffHunk(root, 'task/one', first.snapshotId, 'diff', 2);
  assert.match(hunk.content, /-three/);
  const range = retrieveSourceRange(root, 'task/one', first.snapshotId, 'src/demo.ts', 2, 3);
  assert.equal(range.content, 'two\nthree');
  assert.equal(fingerprintReviewState(input.state), first.stateFingerprint);
});

test('snapshot capture invalidates when review state mutates during collection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestra-evidence-mutation-'));
  const before = state(['src/demo.ts']);
  await assert.rejects(() => captureEvidenceSnapshot({ root, taskId: 'task-two', state: before,
    records: [{ id: 'diff', kind: 'diff', queryIdentity: 'q', provenance: { source: 'test' }, content: 'diff' }],
    readState: () => state(['src/changed.ts']) }), EvidenceMutationError);
});

test('finding ledger preserves blockers across malformed output and omission', () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestra-ledger-'));
  const path = join(root, 'ledger.json');
  let ledger = updateFindingLedger(path, 'task', 'snap-a', 'review-a.txt', JSON.stringify({ findings: [{ id: 'F1', severity: 'blocker', description: 'unsafe path', evidenceRefs: ['evidence://task/snap-a/diff'] }] }), '2026-01-01T00:00:00.000Z');
  assert.equal(ledger.entries[0].disposition, 'open');
  ledger = updateFindingLedger(path, 'task', 'snap-b', 'review-b.txt', 'VERDICT: PASS', '2026-01-02T00:00:00.000Z');
  assert.equal(ledger.entries.find(item => item.id === 'F1')?.disposition, 'open');
  ledger = applyReviewerDisposition(path, 'task', 'F1', 'resolved', 'verified by reviewer', '2026-01-03T00:00:00.000Z');
  assert.equal(loadFindingLedger(path, 'task').entries.find(item => item.id === 'F1')?.disposition, 'resolved');
});
