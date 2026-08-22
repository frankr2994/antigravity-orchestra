import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync } from 'node:fs';
import { Store } from '../dist-server/db.js';
import {
  computeFindingFingerprint,
  buildJulesReviewPacket,
  parseCodexReviewFindings,
  runCodexReviewForJules,
} from '../dist-server/providers/jules/codex-review.js';

// ============================================================================
// Phase 12 Independent Codex Review for Jules PRs Test Suite
// ============================================================================

test('Phase 12 Codex Review — computeFindingFingerprint generates deterministic hashes', () => {
  const fp1 = computeFindingFingerprint({
    severity: 'blocking',
    file: 'server/api.ts',
    explanation: 'Null pointer exception on undefined user property',
  });
  const fp2 = computeFindingFingerprint({
    severity: 'blocking',
    file: 'server/api.ts',
    explanation: 'Null pointer exception on undefined user property',
  });
  assert.equal(fp1, fp2);
  assert.equal(fp1.length, 16);
});

test('Phase 12 Codex Review — buildJulesReviewPacket bounds content and redacts secrets', () => {
  const packet = buildJulesReviewPacket({
    request: 'Add endpoint with key AIzaSy1234567890abcdefghijklmnopqrstuvwxyz',
    baseSha: 'base-sha-1234',
    headSha: 'head-sha-5678',
    changedFiles: ['src/app.ts', 'tests/app.test.ts'],
    diff: '+ const key = "AIzaSy1234567890abcdefghijklmnopqrstuvwxyz";',
    verificationResults: [
      { command: 'npm test', code: 0, output: 'Pass with AIzaSySecretKey' },
    ],
  });

  assert.ok(packet.includes('# Google Jules Cloud PR Review Packet'));
  assert.ok(packet.includes('Base commit SHA: base-sha-1234'));
  assert.ok(packet.includes('Head commit SHA: head-sha-5678'));
  assert.ok(packet.includes('- src/app.ts'));
  assert.ok(!packet.includes('AIzaSy1234567890abcdefghijklmnopqrstuvwxyz'));
  assert.ok(packet.includes('[REDACTED_API_KEY]'));
});

test('Phase 12 Codex Review — parseCodexReviewFindings extracts verdicts and structured findings', () => {
  const reviewText = `
### Architecture Review
The proposed changes look mostly sound, but introduce a critical bug in request handling.

- [BLOCKING] src/app.ts:45 Missing validation check causes unhandled rejection.
- [WARNING] tests/app.test.ts:12 Add additional test coverage for negative branch.
- [INFO] Code formatting is clean.

VERDICT: BLOCK
`;

  const parsed = parseCodexReviewFindings(reviewText, ['src/app.ts', 'tests/app.test.ts']);
  assert.equal(parsed.verdict, 'BLOCK');
  assert.equal(parsed.blocked, true);
  assert.equal(parsed.findings.length, 3);

  const [f1, f2, f3] = parsed.findings;
  assert.equal(f1.severity, 'blocking');
  assert.equal(f1.file, 'src/app.ts');
  assert.equal(f1.line, 45);

  assert.equal(f2.severity, 'warning');
  assert.equal(f2.file, 'tests/app.test.ts');
  assert.equal(f2.line, 12);

  assert.equal(f3.severity, 'info');
});

test('Phase 12 Codex Review — runCodexReviewForJules coordinates review and stores event', async () => {
  const dbPath = join(tmpdir(), `orchestra-cr-db-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const fixtureDir = join(tmpdir(), `orchestra-cr-fix-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(fixtureDir, { recursive: true });

  try {
    const store = new Store(dbPath);
    const project = store.upsertProject({ name: 'test-cr', root: fixtureDir, gitRoot: fixtureDir });
    const session = store.createSession(project.id, 'Test Codex Review Session');
    const task = store.createTask(project.id, session.id, 'Implement cloud feature');

    const mockRunner = async (_prompt, _options) => {
      return `
All verification tests passed in isolated worktree and implementation meets specification.

VERDICT: PASS
`;
    };

    const reviewResult = await runCodexReviewForJules({
      taskId: task.id,
      projectRoot: fixtureDir,
      request: task.prompt,
      baseSha: 'base123',
      headSha: 'head456',
      diff: '+ const newFeature = true;',
      changedFiles: ['src/feature.ts'],
      store,
      codexRunner: mockRunner,
    });

    assert.equal(reviewResult.verdict, 'PASS');
    assert.equal(reviewResult.blocked, false);

    // Verify event in database
    const events = store.listEvents(task.id);
    const reviewEvent = events.find((e) => e.type === 'cloud.reviewed');
    assert.ok(reviewEvent);
    assert.equal(reviewEvent.agent, 'codex');

    store.close();
  } finally {
    try { rmSync(dbPath, { force: true }); } catch { /* Windows file lock */ }
    try { rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* Windows file lock */ }
  }
});
