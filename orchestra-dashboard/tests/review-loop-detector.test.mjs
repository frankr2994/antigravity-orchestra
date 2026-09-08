import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractReviewFindings,
  detectReviewLoop,
} from '../dist-server/application/review/review-services.js';

test('Review Loop Detector — extractReviewFindings extracts structured findings', () => {
  const reviewText = `VERDICT: BLOCK

- **[P1] Presentation exports receive the wrong extension.** downloadBlob always uses wiring.json. [fileSystemGateway.ts](/F:/Wiring/src/documents/fileSystemGateway.ts:28)
- **[P1] Successful native Save metadata is lost from recovery state.** replaceActiveProject omits activeFileName. [replaceProject.ts](/F:/Wiring/src/documents/replaceProject.ts:98)
- **[P2] Filename sanitization does not meet contract.** reserved names missing. [projectCodec.ts](/F:/Wiring/src/documents/projectCodec.ts:13)
`;

  const findings = extractReviewFindings(reviewText);
  assert.equal(findings.length, 3);
  assert.equal(findings[0].severity, 'P1');
  assert.ok(findings[0].title.includes('Presentation exports'));
  assert.ok(findings[0].files.includes('filesystemgateway.ts'));
  assert.equal(findings[1].severity, 'P1');
  assert.equal(findings[2].severity, 'P2');
});

test('Review Loop Detector — healthy progress across 4 cycles is NOT flagged as a loop', () => {
  const history = [
    {
      cycle: 1,
      diffFingerprint: 'diff-1',
      findings: [
        { severity: 'P1', title: 'Issue A', files: ['a.ts'], signature: 'P1:a.ts:issue a' },
        { severity: 'P1', title: 'Issue B', files: ['b.ts'], signature: 'P1:b.ts:issue b' },
        { severity: 'P2', title: 'Issue C', files: ['c.ts'], signature: 'P2:c.ts:issue c' },
      ],
      findingsFingerprint: 'fp-1',
      diffChangedSinceLastCycle: true,
    },
    {
      cycle: 2,
      diffFingerprint: 'diff-2',
      findings: [
        { severity: 'P1', title: 'Issue B refined', files: ['b.ts'], signature: 'P1:b.ts:issue b refined' },
        { severity: 'P2', title: 'Issue C', files: ['c.ts'], signature: 'P2:c.ts:issue c' },
      ],
      findingsFingerprint: 'fp-2',
      diffChangedSinceLastCycle: true,
    },
    {
      cycle: 3,
      diffFingerprint: 'diff-3',
      findings: [
        { severity: 'P2', title: 'Issue C minor', files: ['c.ts'], signature: 'P2:c.ts:issue c minor' },
      ],
      findingsFingerprint: 'fp-3',
      diffChangedSinceLastCycle: true,
    },
    {
      cycle: 4,
      diffFingerprint: 'diff-4',
      findings: [],
      findingsFingerprint: 'fp-4',
      diffChangedSinceLastCycle: true,
    },
  ];

  const result = detectReviewLoop(history);
  assert.equal(result.isLoop, false);
});

test('Review Loop Detector — stagnant repair with 0 code changes is flagged as loop', () => {
  const history = [
    {
      cycle: 1,
      diffFingerprint: 'diff-1',
      findings: [{ severity: 'P1', title: 'Issue A', files: ['a.ts'], signature: 'P1:a.ts:issue a' }],
      findingsFingerprint: 'fp-1',
      diffChangedSinceLastCycle: true,
    },
    {
      cycle: 2,
      diffFingerprint: 'diff-1',
      findings: [{ severity: 'P1', title: 'Issue A', files: ['a.ts'], signature: 'P1:a.ts:issue a' }],
      findingsFingerprint: 'fp-1',
      diffChangedSinceLastCycle: false, // 0 code changes made by repair
    },
  ];

  const result = detectReviewLoop(history);
  assert.equal(result.isLoop, true);
  assert.ok(result.reason?.includes('Stagnant repair'));
});

test('Review Loop Detector — oscillating flip-flop between 2 states is flagged as loop', () => {
  const history = [
    {
      cycle: 1,
      diffFingerprint: 'diff-state-A',
      findings: [{ severity: 'P1', title: 'Issue A', files: ['a.ts'], signature: 'P1:a.ts:issue a' }],
      findingsFingerprint: 'fp-A',
      diffChangedSinceLastCycle: true,
    },
    {
      cycle: 2,
      diffFingerprint: 'diff-state-B',
      findings: [{ severity: 'P1', title: 'Issue B', files: ['b.ts'], signature: 'P1:b.ts:issue b' }],
      findingsFingerprint: 'fp-B',
      diffChangedSinceLastCycle: true,
    },
    {
      cycle: 3,
      diffFingerprint: 'diff-state-A', // Reverted back to state A
      findings: [{ severity: 'P1', title: 'Issue A', files: ['a.ts'], signature: 'P1:a.ts:issue a' }],
      findingsFingerprint: 'fp-A',
      diffChangedSinceLastCycle: true,
    },
  ];

  const result = detectReviewLoop(history);
  assert.equal(result.isLoop, true);
  assert.ok(result.reason?.includes('Oscillating loop'));
});

test('Review Loop Detector — persistent identical blockers across 3 cycles flagged as loop', () => {
  const history = [
    {
      cycle: 1,
      diffFingerprint: 'diff-1',
      findings: [{ severity: 'P1', title: 'Stuck blocker', files: ['s.ts'], signature: 'P1:s.ts:stuck blocker' }],
      findingsFingerprint: 'fp-1',
      diffChangedSinceLastCycle: true,
    },
    {
      cycle: 2,
      diffFingerprint: 'diff-2',
      findings: [{ severity: 'P1', title: 'Stuck blocker', files: ['s.ts'], signature: 'P1:s.ts:stuck blocker' }],
      findingsFingerprint: 'fp-2',
      diffChangedSinceLastCycle: true,
    },
    {
      cycle: 3,
      diffFingerprint: 'diff-3',
      findings: [{ severity: 'P1', title: 'Stuck blocker', files: ['s.ts'], signature: 'P1:s.ts:stuck blocker' }],
      findingsFingerprint: 'fp-3',
      diffChangedSinceLastCycle: true,
    },
  ];

  const result = detectReviewLoop(history);
  assert.equal(result.isLoop, true);
  assert.ok(result.reason?.includes('Persistent unresolved blockers'));
});
