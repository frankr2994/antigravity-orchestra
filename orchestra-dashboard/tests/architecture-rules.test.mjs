import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactSecrets, redactSecretsDeep } from '../dist-server/infrastructure/security/redaction.js';

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

export function detectCycles(graph) {
  const visited = new Set();
  const recStack = new Set();
  const cycles = [];

  function dfs(node, path = []) {
    visited.add(node);
    recStack.add(node);
    const neighbors = graph.get(node) || [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        dfs(neighbor, [...path, node]);
      } else if (recStack.has(neighbor)) {
        cycles.push([...path, node, neighbor]);
      }
    }
    recStack.delete(node);
  }

  for (const file of graph.keys()) {
    if (!visited.has(file)) {
      dfs(file);
    }
  }

  return cycles;
}

// ============================================================================
// Architecture Rules & Modularity Boundary Test Suite (Stage A)
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
      if (
        content.includes("from '../infrastructure") ||
        content.includes("from '../../infrastructure") ||
        content.includes("from '../providers") ||
        content.includes("from '../../providers")
      ) {
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
  const orchestraTaskStates = [
    'queued',
    'preflight',
    'baseline_required',
    'routing',
    'running',
    'recovering',
    'recovery_required',
    'reviewing',
    'verifying',
    'summarizing',
    'committing',
    'pushing',
    'completed',
    'completed_unpushed',
    'failed',
    'cancelled',
    'review_disputed',
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

test('Phase 2 Architecture — Secret Redaction in Loggers, Objects, and Event Streams', () => {
  const sensitiveStrings = [
    'ghp_1234567890abcdefghijklmnopqrstuvwxyz',
    'AIzaSyB1234567890abcdefghijklmnopqrstuvwxyz',
    'sk-proj-1234567890abcdefghijklmnopqrstuvwxyz',
    'https://user:password123@github.com/org/repo.git',
  ];

  // Every sensitive token must be recognized and sanitized by redactSecrets
  for (const secret of sensitiveStrings) {
    const redacted = redactSecrets(secret);
    assert.ok(!redacted.includes('AIzaSyB1234567890abcdefghijklmnopqrstuvwxyz'), `Must redact AIzaSy token: ${secret}`);
    assert.ok(!redacted.includes('ghp_1234567890abcdefghijklmnopqrstuvwxyz'), `Must redact ghp token: ${secret}`);
    assert.ok(!redacted.includes('password123'), `Must redact URL password: ${secret}`);
  }

  // Deep redaction
  const nestedObj = {
    auth: 'sk-proj-mysecret',
    list: ['Bearer ya29.secret123', 'safe string'],
    nested: { url: 'http://admin:superpass@localhost:8080' },
  };
  const sanitized = redactSecretsDeep(nestedObj);
  assert.equal(sanitized.auth, '[REDACTED_KEY]');
  assert.equal(sanitized.list[0], 'Bearer [REDACTED_TOKEN]');
  assert.equal(sanitized.nested.url, 'http://admin:[REDACTED_PASSWORD]@localhost:8080');
});

test('Phase 2 Architecture — Circular Dependency Detection across Server Files', () => {
  const allServerFiles = getSourceFiles(serverDir).filter((f) => f.endsWith('.ts'));
  const graph = new Map();

  for (const file of allServerFiles) {
    const content = readFileSync(file, 'utf-8');
    const imports = [];
    const importRegex = /(?:import|export)\s+(?:[\s\S]*?from\s+)?['"](\.[^'"]+)['"]/g;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const relImport = match[1];
      const targetBase = resolve(dirname(file), relImport.replace(/\.js$/, ''));
      const possibleTs = `${targetBase}.ts`;
      const possibleIndex = join(targetBase, 'index.ts');
      if (allServerFiles.includes(possibleTs)) {
        imports.push(possibleTs);
      } else if (allServerFiles.includes(possibleIndex)) {
        imports.push(possibleIndex);
      }
    }
    graph.set(file, imports);
  }

  const cycles = detectCycles(graph);
  assert.deepEqual(cycles, [], `Found circular dependencies in server source files: ${JSON.stringify(cycles)}`);
});

test('Phase 2 Architecture — Negative Cycle Detection Fixture Verification', () => {
  // Negative test: verify that deliberate cycles ARE detected by the algorithm
  const mockGraphWithCycle = new Map([
    ['moduleA', ['moduleB']],
    ['moduleB', ['moduleC']],
    ['moduleC', ['moduleA']], // cycle: A -> B -> C -> A
    ['moduleD', ['moduleC']],
  ]);

  const detectedCycles = detectCycles(mockGraphWithCycle);
  assert.ok(detectedCycles.length > 0, 'Circular dependency algorithm must detect intentional cycle');
});

test('Modularity ratchet — Jules controllers depend only on application/config and shared HTTP code', () => {
  const controllerDir = join(serverDir, 'api', 'routes', 'jules');
  const violations = getSourceFiles(controllerDir).flatMap((file) => {
    const content = readFileSync(file, 'utf8');
    return /from\s+['"][^'"]*(?:providers|infrastructure|db\.js|tasks\.js)[^'"]*['"]/.test(content)
      ? [file.replace(serverDir, '').replace(/\\/g, '/')]
      : [];
  });
  assert.deepEqual(violations, []);
});

test('Modularity ratchet — TaskManager delegates scheduling, events, and Git finalization', () => {
  const taskManager = readFileSync(join(serverDir, 'tasks.ts'), 'utf8');
  assert.match(taskManager, /ProjectTaskScheduler/);
  assert.match(taskManager, /TaskEventPublisher/);
  assert.match(taskManager, /GitFinalizationService/);
  assert.doesNotMatch(taskManager, /new EventEmitter|private readonly queue|private readonly controllers/);
});

test('Modularity ratchet — frontend contracts and UI primitives stay outside App', () => {
  const app = readFileSync(resolve(serverDir, '..', 'src', 'App.tsx'), 'utf8');
  assert.match(app, /from ['"]\.\/app\/types['"]/);
  assert.match(app, /from ['"]\.\/shared\/ui['"]/);
  assert.doesNotMatch(app, /^type (?:Project|Task|TaskEvent|SettingsData)\s*=/m);
  assert.doesNotMatch(app, /^function (?:Metric|PageHeader|Card|NavButton|Empty|StatusDot|StateBadge|Field)\b/m);
});

test('Modularity ratchet — routing policy and managed worktrees have provider-neutral owners', () => {
  const routing = readFileSync(join(serverDir, 'domain', 'execution', 'routing-policy.ts'), 'utf8');
  const microEdit = readFileSync(join(serverDir, 'application', 'gemma', 'micro-edit-service.ts'), 'utf8');
  const providerRouter = readFileSync(join(serverDir, 'providers', 'jules', 'router.ts'), 'utf8');
  assert.doesNotMatch(routing, /from\s+['"][^'"]*(?:application|providers|infrastructure)/);
  assert.doesNotMatch(microEdit, /providers\/jules/);
  assert.doesNotMatch(providerRouter, /application\/jules/);
});

test('Modularity ratchet — App delegates workspace transactions, API transport, and usage presentation', () => {
  const app = readFileSync(resolve(serverDir, '..', 'src', 'App.tsx'), 'utf8');
  assert.match(app, /useWorkspaceState/);
  assert.match(app, /useApiClient/);
  assert.match(app, /ProviderUsageCard/);
  assert.doesNotMatch(app, /useState<Project\[\]>/);
  assert.doesNotMatch(app, /function api</);
  assert.doesNotMatch(app, /function resetTimer/);
});
