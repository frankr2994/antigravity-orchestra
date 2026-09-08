import test from 'node:test';
import assert from 'node:assert/strict';
import { routeJulesHandoff, cheaperCapacityFallback } from '../dist-server/application/jules/handoff-routing.js';
import { RiderCircuitBreaker } from '../dist-server/application/capabilities/rider-circuit-breaker.js';
import { codexAppServerArgs } from '../dist-server/codex-app-server.js';
import { parseJulesAutomationStatus, parseJulesOutstandingRepair } from '../dist-server/domain/index.js';
import { cloudProgressDetail, taskNextAction } from '../dist-server/application/tasks/run-monitor-service.js';

test('handoff routing is local-first and escalation is risk-gated', () => {
  assert.equal(routeJulesHandoff({ kind: 'waiting_for_head', text: '' }).handler, 'deterministic');
  assert.equal(routeJulesHandoff({ kind: 'user_feedback', text: 'ordinary clarification', gemmaInputTokens: 750, gemmaContextTokens: 1000 }).model, 'gemma');
  assert.deepEqual(routeJulesHandoff({ kind: 'plan_approval', text: 'ordinary plan' }), {
    handler: 'codex', model: 'gpt-5.6-luna', effort: 'medium', reason: 'Luna Medium is the default paid plan gate.',
  });
  assert.equal(routeJulesHandoff({ kind: 'plan_approval', text: 'database migration architecture' }).model, 'gpt-5.6-terra');
  assert.equal(routeJulesHandoff({ kind: 'review_repair', text: 'security destructive ambiguity', lunaEscalation: 'sol', terraUnresolved: true }).model, 'gpt-5.6-sol');
  assert.equal(cheaperCapacityFallback('gpt-5.6-terra'), 'gpt-5.6-luna');
  assert.equal(cheaperCapacityFallback('gpt-5.6-luna'), 'wait');
});

test('historical automation JSON is runtime validated and fails closed', () => {
  assert.throws(() => parseJulesAutomationStatus({ version: 1, state: 'made_up' }), /unknown|invalid/i);
  assert.throws(() => parseJulesOutstandingRepair({ version: 1, taskId: 't', headSha: 'short' }), /invalid/i);
});

test('Rider endpoint circuit opens, permits one half-open probe, and resets only after initialize plus tools/list', () => {
  let now = 0;
  const breaker = new RiderCircuitBreaker(() => now);
  assert.equal(breaker.permit('http://127.0.0.1/rider'), true);
  breaker.recordFailure('http://127.0.0.1/rider');
  now += 1;
  breaker.recordFailure('http://127.0.0.1/rider');
  assert.equal(breaker.state('http://127.0.0.1/rider'), 'open');
  assert.equal(breaker.permit('http://127.0.0.1/rider'), false);
  now += 600_000;
  assert.equal(breaker.permit('http://127.0.0.1/rider'), true);
  assert.equal(breaker.permit('http://127.0.0.1/rider'), false);
  breaker.recordInitialize('http://127.0.0.1/rider');
  assert.equal(breaker.state('http://127.0.0.1/rider'), 'half_open');
  breaker.recordToolsListed('http://127.0.0.1/rider');
  assert.equal(breaker.state('http://127.0.0.1/rider'), 'closed');
});

test('no-Rider Codex app-server uses process-local override without global configuration edits', () => {
  assert.deepEqual(codexAppServerArgs(true), ['-c', 'mcp_servers.rider.enabled=false', 'app-server']);
  assert.deepEqual(codexAppServerArgs(false), ['app-server']);
});

test('run monitor treats ordinary Jules attention as automation-owned until a true authority blocker', () => {
  assert.match(taskNextAction('running', 'AWAITING_USER_FEEDBACK', 'awaiting_provider_resume', false), /No manual action/i);
  assert.match(cloudProgressDetail('running', 'AWAITING_USER_FEEDBACK', false, 'awaiting_provider_resume', false), /waiting for later agent activity/i);
  assert.match(taskNextAction('running', 'AWAITING_USER_FEEDBACK', 'blocked', false), /authority blocker/i);
  assert.match(cloudProgressDetail('running', 'AWAITING_USER_FEEDBACK', false, null, true), /malformed/i);
});
