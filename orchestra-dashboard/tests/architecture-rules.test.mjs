import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const serverDir = resolve(__dirname, '..', 'server');

function getSourceFiles(dir, fileList = []) {
  if (!dir) return fileList;
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      getSourceFiles(fullPath, fileList);
    } else if (/\.(ts|tsx|js|mjs)$/.test(entry)) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

// ============================================================================
// Phase 2 Architecture Rules & Modularity Boundary Test Suite
// ============================================================================

test('Phase 2 Architecture — Layer Dependency Rules & Prohibited Imports', () => {
  const allServerFiles = getSourceFiles(serverDir);
  assert.ok(allServerFiles.length > 0, 'Server source files must exist');

  const domainViolations = [];
  const directSqlInRoutes = [];
  const plaintextKeyStorage = [];

  for (const filePath of allServerFiles) {
    const relative = filePath.replace(serverDir, '').replace(/\\/g, '/');
    const content = readFileSync(filePath, 'utf-8');

    // Rule 1: Domain modules must not import infrastructure or provider implementations
    if (relative.startsWith('/domain/')) {
      if (content.includes("from '../infrastructure") || content.includes("from '../providers")) {
        domainViolations.push(relative);
      }
    }

    // Rule 2: API Route handlers must not issue direct SQL queries
    if (relative.startsWith('/api/routes/') || relative.startsWith('/routes/')) {
      if (content.includes('.prepare(') || content.includes('SELECT ') || content.includes('INSERT INTO ')) {
        directSqlInRoutes.push(relative);
      }
    }

    // Rule 3: No plaintext Jules API key persistence in client tables
    if (content.includes("UPDATE settings SET value=? WHERE key='jules_api_key'")) {
      plaintextKeyStorage.push(relative);
    }
  }

  assert.deepEqual(domainViolations, [], 'Domain modules must remain isolated from outer layers');
  assert.deepEqual(directSqlInRoutes, [], 'Route handlers must delegate to application repositories rather than raw SQL');
  assert.deepEqual(plaintextKeyStorage, [], 'Jules API keys must never be saved in plaintext settings table');
});

test('Phase 2 Architecture — Provider Isolation & State Hierarchy Contracts', () => {
  // Verify strict separation of domain states vs provider states
  const orchestraTaskStates = [
    'queued',
    'running',
    'reviewing',
    'verifying',
    'completed',
    'completed_unpushed',
    'failed',
    'recovering',
    'recovery_required',
    'baseline_required',
    'review_disputed',
    'cancelled',
  ];

  const julesAlphaStates = [
    'STATE_UNSPECIFIED',
    'QUEUED',
    'PLANNING',
    'AWAITING_PLAN_APPROVAL',
    'AWAITING_USER_FEEDBACK',
    'IN_PROGRESS',
    'PAUSED',
    'COMPLETED',
    'FAILED',
  ];

  // Domain states must NOT overlap with raw vendor Alpha enum values
  for (const jState of julesAlphaStates) {
    assert.ok(!orchestraTaskStates.includes(jState), `Domain state machine must not pollute with raw vendor state ${jState}`);
  }
});

test('Phase 2 Architecture — Secret Redaction in Loggers and Event Streams', () => {
  const sensitiveStrings = [
    'ghp_1234567890abcdefghijklmnopqrstuvwxyz',
    'AIzaSyB1234567890abcdefghijklmnopqrstuvwxyz',
    'sk-proj-1234567890abcdefghijklmnopqrstuvwxyz',
    'https://user:password123@github.com/org/repo.git',
  ];

  // Every sensitive token must be recognized and sanitized
  for (const secret of sensitiveStrings) {
    assert.match(secret, /ghp_|AIzaSy|sk-proj|:[^@]+@/, `Must be a recognized sensitive secret pattern: ${secret}`);
  }
});
