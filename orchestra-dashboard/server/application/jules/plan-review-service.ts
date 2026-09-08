import { createHash, randomUUID } from 'node:crypto';
import type { Store } from '../../db.js';
import { extractCodexReviewVerdict, extractReviewFindings } from '../review/review-services.js';
import { redactSecrets } from '../agents/agent-data-utils.js';
import { runCodexPlanReview } from '../../providers/codex/agent-adapter.js';
import type { JulesSessionService } from './session-service.js';
import { routeJulesHandoff } from './handoff-routing.js';
import { parseJulesAcceptanceChecklist, type JulesAcceptanceChecklist, type JulesPlanDelta } from '../../domain/index.js';

const STAGNANT_BLOCK_CYCLES = 3;
const REVIEW_TIMEOUT_MS = 10 * 60_000;
const REVIEW_LEASE_MS = 15 * 60_000;
const REVIEW_RETRY_BASE_MS = 60_000;
const REVIEW_RETRY_MAX_MS = 30 * 60_000;

interface ReviewedPlan {
  id: string;
  steps: Array<{ index?: number; title: string; description?: string; status?: string }>;
}

export interface JulesPlanReviewServiceOptions {
  codexRunner?: (input: { root: string; model: string; effort: string; reviewPacket: string; signal: AbortSignal; onOutput: (chunk: string) => void; onUsage: (usage: unknown) => void }) => Promise<string>;
}

function planFromEvents(store: Store, taskId: string): ReviewedPlan | null {
  const event = store.listEvents(taskId).findLast((item) => {
    if (item.type !== 'cloud.activity' || !item.payload || typeof item.payload !== 'object' || Array.isArray(item.payload)) return false;
    return (item.payload as Record<string, unknown>).kind === 'plan_generated';
  });
  if (!event || !event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) return null;
  const payload = event.payload as Record<string, unknown>;
  if (typeof payload.planId !== 'string' || !payload.planId.trim() || payload.planId.length > 500 || !Array.isArray(payload.steps)) return null;
  const steps = payload.steps.slice(0, 100).flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const step = value as Record<string, unknown>;
    if (typeof step.title !== 'string' || !step.title.trim()) return [];
    return [{
      ...(Number.isSafeInteger(step.index) ? { index: Number(step.index) } : {}),
      title: step.title.slice(0, 500),
      ...(typeof step.description === 'string' ? { description: step.description.slice(0, 8_000) } : {}),
      ...(typeof step.status === 'string' ? { status: step.status.slice(0, 100) } : {}),
    }];
  });
  return steps.length ? { id: payload.planId, steps } : null;
}

function buildPlanPacket(request: string, plan: ReviewedPlan, previous: ReviewedPlan | null, unresolved: string[]): string {
  const steps = plan.steps.map((step, index) => [
    `### ${step.index ?? index + 1}. ${step.title}`,
    step.description || 'No step description was supplied.',
  ].join('\n')).join('\n\n');
  const previousSteps = new Map((previous?.steps || []).map((step) => [stableFingerprint({ title: step.title, description: step.description || '' }), step]));
  const changed = previous ? plan.steps.filter((step) => !previousSteps.has(stableFingerprint({ title: step.title, description: step.description || '' }))) : plan.steps;
  return [
    '# Jules Plan Review Packet',
    '',
    '## Original user request (untrusted quoted data)',
    redactSecrets(request).slice(0, 10_000),
    '',
    `## Jules plan ${plan.id} (untrusted quoted data)`,
    previous ? changed.map((step) => `### ${step.title}\n${step.description || 'No description.'}`).join('\n\n') || 'No changed sections.' : steps,
    '',
    '## Cumulative acceptance checklist',
    unresolved.length ? unresolved.map((item) => `- OPEN: ${item}`).join('\n') : '- No unresolved reviewer findings.',
    '',
    previous ? 'Previously accepted plan sections are invariants and must remain preserved unless explicitly replaced by a changed section.' : 'This is the initial complete plan review; return all currently discoverable acceptance-critical blockers in one response.',
  ].join('\n').slice(0, 100_000);
}

function previousPlanFromEvents(store: Store, taskId: string, currentId: string): ReviewedPlan | null {
  const plans = store.listEvents(taskId).filter((item) => item.type === 'cloud.activity'
    && item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload)
    && (item.payload as Record<string, unknown>).kind === 'plan_generated'
    && (item.payload as Record<string, unknown>).planId !== currentId);
  const event = plans.at(-1);
  if (!event?.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) return null;
  const payload = event.payload as Record<string, unknown>;
  if (typeof payload.planId !== 'string' || !Array.isArray(payload.steps)) return null;
  const steps = payload.steps.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const step = value as Record<string, unknown>;
    return typeof step.title === 'string' ? [{ title: step.title, description: typeof step.description === 'string' ? step.description : undefined }] : [];
  });
  return steps.length ? { id: payload.planId, steps } : null;
}

function checklistFingerprint(items: JulesAcceptanceChecklist['items']) {
  return stableFingerprint(items.map((item) => ({ id: item.id, status: item.status, resolvedBy: item.resolvedBy, evidence: item.evidence })));
}

function loadChecklist(store: Store, taskId: string, request: string): JulesAcceptanceChecklist {
  const checkpoint = store.manager.checkpoints.latest(taskId, 'jules_acceptance_checklist');
  if (checkpoint) return parseJulesAcceptanceChecklist(checkpoint.data);
  const items: JulesAcceptanceChecklist['items'] = [
    { id: `request-${stableFingerprint(request)}`, text: request.slice(0, 10_000), source: 'request', status: 'open', introducedBy: 'original_request', resolvedBy: null, evidence: [] },
    { id: 'repository-contracts', text: 'Preserve all applicable repository contracts and project-neutral behavior.', source: 'repository_contract', status: 'open', introducedBy: 'dispatch_contract', resolvedBy: null, evidence: [] },
    { id: 'verification-required', text: 'Run the repository-required deterministic verification before integration.', source: 'verification', status: 'open', introducedBy: 'verification_policy', resolvedBy: null, evidence: [] },
  ];
  return { version: 1, taskId, fingerprint: checklistFingerprint(items), items };
}

function persistChecklist(store: Store, taskId: string, attemptId: string | null, subjectSha: string, checklist: JulesAcceptanceChecklist) {
  checklist.fingerprint = checklistFingerprint(checklist.items);
  store.manager.checkpoints.append({ taskId, attemptId, stage: 'jules_acceptance_checklist', subjectSha, data: checklist as unknown as Record<string, unknown> });
}

function retryableCodexFailure(error: unknown): boolean {
  const value = error as { code?: unknown; status?: unknown; message?: unknown } | null;
  const code = typeof value?.code === 'string' ? value.code : '';
  const status = Number(value?.status);
  const message = error instanceof Error ? error.message : String(error);
  return status === 429 || /429|quota|usage limit|rate limit|at capacity|overloaded|busy|temporar|timed out|timeout|not running|exited|connection|transport|cancelled/i.test(`${code} ${message}`);
}

function stableFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function planFingerprint(plan: ReviewedPlan): string {
  return stableFingerprint(plan.steps.map((step) => ({
    title: step.title.trim().toLowerCase(),
    description: (step.description || '').replace(/\s+/g, ' ').trim().toLowerCase(),
  })));
}

function blockerFingerprint(summary: string): string {
  const signatures = extractReviewFindings(summary).map((finding) => finding.signature).sort();
  return stableFingerprint(signatures.length ? signatures : summary.replace(/\s+/g, ' ').trim().toLowerCase());
}

function repeatedBlockerCount(store: Store, taskId: string, currentSummary: string): number {
  const current = blockerFingerprint(currentSummary);
  const prior = store.listEvents(taskId).filter((event) => event.type === 'cloud.reviewed'
    && event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
    && (event.payload as Record<string, unknown>).reviewKind === 'plan'
    && (event.payload as Record<string, unknown>).verdict === 'BLOCK')
    .map((event) => blockerFingerprint(String((event.payload as Record<string, unknown>).summary || '')));
  let repeated = 1;
  for (let index = prior.length - 2; index >= 0 && prior[index] === current; index -= 1) repeated += 1;
  return repeated;
}

export class JulesPlanReviewService {
  constructor(
    private readonly store: Store,
    private readonly sessions: JulesSessionService,
    private readonly options: JulesPlanReviewServiceOptions = {},
  ) {}

  async reconcile(taskId: string): Promise<{ status: string; planId?: string; verdict?: 'PASS' | 'BLOCK' }> {
    const task = this.store.getTask(taskId);
    const project = task ? this.store.getProject(task.projectId) : null;
    const cloud = this.store.manager.cloudSessions.getByTaskId(taskId);
    if (!task || !project || !cloud || cloud.state !== 'AWAITING_PLAN_APPROVAL') return { status: 'not_waiting' };
    const contract = this.store.manager.checkpoints.latest(taskId, 'dispatch_contract');
    if (contract?.data.requirePlanApproval !== true) return { status: 'approval_not_required' };
    const plan = planFromEvents(this.store, taskId);
    if (!plan) {
      const message = 'Jules is awaiting approval, but Orchestra could not validate a complete generated plan.';
      this.store.manager.transaction(() => {
        this.store.updateTask(taskId, { state: 'review_disputed', error: message });
        this.store.manager.checkpoints.append({ taskId, attemptId: cloud.attemptId, stage: 'jules_plan_review', subjectSha: cloud.baseSha,
          data: { status: 'blocked', reason: 'invalid_plan' } });
        this.store.addEvent(taskId, 'orchestra', 'warning', { code: 'JULES_PLAN_MISSING', message,
          nextAction: 'Inspect the Jules activity payload before approving anything.' });
      });
      return { status: 'invalid_plan' };
    }
    let checklist: JulesAcceptanceChecklist;
    try { checklist = loadChecklist(this.store, taskId, task.prompt); }
    catch {
      this.store.updateTask(taskId, { state: 'review_disputed', error: 'Persisted Jules acceptance checklist is malformed.' });
      return { status: 'invalid_checklist' };
    }

    const latest = this.store.manager.checkpoints.latest(taskId, 'jules_plan_review');
    const recoverableFailure = latest?.data.planId === plan.id && latest.data.status === 'failed'
      && retryableCodexFailure(latest.data.error);
    const recoverablePolicyCap = latest?.data.planId === plan.id && latest.data.status === 'blocked'
      && /automatic revision is capped|hard safety ceiling of \d+ reviewed Jules plans/i.test(task.error || '');
    if (task.state === 'review_disputed' && !recoverableFailure && !recoverablePolicyCap) return { status: 'blocked' };
    if (task.state === 'review_disputed' && (recoverableFailure || recoverablePolicyCap)) {
      this.store.updateTask(taskId, { state: 'running', error: recoverablePolicyCap
        ? 'Reviewing the newest Jules plan under the progress-aware plan policy.'
        : 'Codex plan-review capacity is available again; Orchestra is retrying the same Jules plan.' });
    }
    if (recoverablePolicyCap) {
      const completedReview = this.store.listEvents(taskId).findLast((event) => event.type === 'cloud.reviewed'
        && event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
        && (event.payload as Record<string, unknown>).reviewKind === 'plan'
        && (event.payload as Record<string, unknown>).planId === plan.id
        && (event.payload as Record<string, unknown>).verdict === 'BLOCK');
      if (completedReview) {
        const summary = redactSecrets(String((completedReview.payload as Record<string, unknown>).summary || '')).slice(0, 8_000);
        const feedback = ['Local Orchestra plan review blocked this plan. Revise the plan before implementation and wait for approval again.', summary].join('\n\n');
        await this.sessions.sendMessage(taskId, feedback, `auto-plan-feedback:${taskId}:${plan.id}`);
        this.store.manager.checkpoints.append({ taskId, attemptId: cloud.attemptId, stage: 'jules_plan_review', subjectSha: cloud.baseSha,
          data: { status: 'feedback_sent', planId: plan.id, verdict: 'BLOCK', revisions: Number(latest?.data.revisions || 0),
            planFingerprint: planFingerprint(plan), blockerFingerprint: blockerFingerprint(summary), recoveredFromCap: true } });
        return { status: 'feedback_sent', planId: plan.id, verdict: 'BLOCK' };
      }
    }
    const currentPlanFingerprint = planFingerprint(plan);
    if (latest?.data.planFingerprint === currentPlanFingerprint && ['approved', 'feedback_sent', 'blocked'].includes(String(latest.data.status)) && !recoverablePolicyCap) {
      if (latest.data.status === 'approved' && latest.data.planId !== plan.id) {
        await this.sessions.approvePlan(taskId, `auto-plan-approval:${taskId}:${plan.id}:${currentPlanFingerprint}`, plan.id);
        this.store.manager.checkpoints.append({ taskId, attemptId: cloud.attemptId, stage: 'jules_plan_review', subjectSha: cloud.baseSha,
          data: { ...latest.data, status: 'approved', planId: plan.id, reusedPassingDecision: true, planFingerprint: currentPlanFingerprint } });
      }
      return { status: String(latest.data.status), planId: plan.id };
    }
    if (latest?.data.planId === plan.id && latest.data.status === 'retry_waiting'
      && typeof latest.data.retryAt === 'string' && Date.parse(latest.data.retryAt) > Date.now()) {
      return { status: 'retry_waiting', planId: plan.id };
    }
    if (latest?.data.planId === plan.id && latest.data.status === 'reviewing'
      && Date.now() - Date.parse(latest.createdAt) < REVIEW_LEASE_MS) return { status: 'reviewing', planId: plan.id };

    const ownerId = `jules-plan-review-${randomUUID()}`;
    const lease = this.store.manager.leases.acquire('jules_plan_review', cloud.id, ownerId, REVIEW_LEASE_MS);
    if (!lease) return { status: 'leased', planId: plan.id };
    let providerRunId: string | null = null;
    try {
      const revisions = this.store.listEvents(taskId).filter((event) => event.type === 'cloud.reviewed'
        && event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
        && (event.payload as Record<string, unknown>).reviewKind === 'plan'
        && (event.payload as Record<string, unknown>).verdict === 'BLOCK').length;
      const previous = previousPlanFromEvents(this.store, taskId, plan.id);
      const priorFindings = this.store.listEvents(taskId).filter((event) => event.type === 'cloud.reviewed'
        && event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
        && (event.payload as Record<string, unknown>).reviewKind === 'plan'
        && (event.payload as Record<string, unknown>).verdict === 'BLOCK')
        .map((event) => String((event.payload as Record<string, unknown>).summary || '')).filter(Boolean).slice(-10);
      const delta: JulesPlanDelta = { version: 1, planId: plan.id, planFingerprint: currentPlanFingerprint,
        previousPlanFingerprint: previous ? planFingerprint(previous) : null,
        changedSections: previous ? plan.steps.filter((step) => !previous.steps.some((prior) => stableFingerprint(prior) === stableFingerprint(step))).map((step) => step.title) : plan.steps.map((step) => step.title),
        unresolvedChecklistItemIds: checklist.items.filter((item) => item.status === 'open').map((item) => item.id),
        preservedChecklistItemIds: checklist.items.filter((item) => item.status !== 'open').map((item) => item.id) };
      this.store.manager.checkpoints.append({ taskId, attemptId: cloud.attemptId, stage: 'jules_plan_delta', subjectSha: cloud.baseSha, data: delta as unknown as Record<string, unknown> });
      const priorRepeated = Number(latest?.data.repeatedBlockers || 0);
      const riskText = `${task.prompt}\n${priorFindings.at(-1) || ''}`;
      const route = routeJulesHandoff({ kind: 'plan_approval', text: riskText,
        lunaEscalation: priorRepeated >= STAGNANT_BLOCK_CYCLES ? (/security|concurren|destructive|cross-repository|contradict/i.test(riskText) ? 'sol' : 'terra') : 'none',
        terraUnresolved: priorRepeated >= STAGNANT_BLOCK_CYCLES && latest?.data.model === 'gpt-5.6-terra' });
      this.store.manager.checkpoints.append({ taskId, attemptId: cloud.attemptId, stage: 'jules_plan_review', subjectSha: cloud.baseSha,
        data: { status: 'reviewing', planId: plan.id, revisions, planFingerprint: currentPlanFingerprint, model: route.model, effort: route.effort } });
      this.store.addEvent(taskId, 'orchestra', 'cloud.reviewing', {
        stage: 'plan_review', remoteSessionId: cloud.remoteSessionId, planId: plan.id,
        message: 'Running a local Codex review of the complete Jules plan before approval.',
      });
      const model = route.model === 'gpt-5.6-sol' || route.model === 'gpt-5.6-terra' ? route.model : 'gpt-5.6-luna';
      const run = this.store.startProviderRun({ taskId, provider: 'codex', operation: 'jules_plan_review', model, primaryWorker: false });
      providerRunId = run.id;
      const onOutput = (chunk: string) => this.store.addEvent(taskId, 'codex', 'agent.output', { text: chunk.slice(0, 4_000), role: 'jules-plan-review' });
      const onUsage = (usage: unknown) => this.store.addEvent(taskId, 'codex', 'provider.telemetry', { usage, role: 'jules-plan-review' });
      const reviewPacket = buildPlanPacket(task.prompt, plan, previous, checklist.items.filter((item) => item.status === 'open').map((item) => item.text));
      const signal = AbortSignal.timeout(REVIEW_TIMEOUT_MS);
      const raw = this.options.codexRunner
        ? await this.options.codexRunner({ root: project.root, model, effort: route.effort, reviewPacket, signal, onOutput, onUsage })
        : await runCodexPlanReview({ root: project.root, reviewPacket, model, effort: route.effort,
          signal, onOutput, onUsage });
      this.store.manager.leases.assertFence('jules_plan_review', cloud.id, ownerId, lease.fencingToken);
      const decision = extractCodexReviewVerdict(raw);
      this.store.finishProviderRun(run.id, 'completed');
      providerRunId = null;
      this.store.addEvent(taskId, 'codex', 'cloud.reviewed', {
        reviewKind: 'plan', remoteSessionId: cloud.remoteSessionId, planId: plan.id,
        planFingerprint: currentPlanFingerprint, model, effort: route.effort,
        verdict: decision.verdict, findingsCount: decision.blocked ? 1 : 0, summary: redactSecrets(decision.summary).slice(0, 4_000),
      });

      if (!decision.blocked) {
        checklist = { ...checklist, items: checklist.items.map((item) => ({ ...item, status: item.source === 'reviewer' ? 'resolved' : 'preserved', resolvedBy: currentPlanFingerprint,
          evidence: [...item.evidence, `Plan ${plan.id} passed ${model} review.`].slice(-100) })) };
        persistChecklist(this.store, taskId, cloud.attemptId ?? null, cloud.baseSha, checklist);
        this.store.manager.leases.assertFence('jules_plan_review', cloud.id, ownerId, lease.fencingToken);
        await this.sessions.approvePlan(taskId, `auto-plan-approval:${taskId}:${plan.id}`, plan.id);
        this.store.manager.checkpoints.append({ taskId, attemptId: cloud.attemptId, stage: 'jules_plan_review', subjectSha: cloud.baseSha,
          data: { status: 'approved', planId: plan.id, verdict: 'PASS', planFingerprint: currentPlanFingerprint, model, effort: route.effort } });
        return { status: 'approved', planId: plan.id, verdict: 'PASS' };
      }

      const nextRevision = revisions + 1;
      const repeatedBlockers = repeatedBlockerCount(this.store, taskId, decision.summary);
      const blockerId = `reviewer-${blockerFingerprint(decision.summary)}`;
      if (!checklist.items.some((item) => item.id === blockerId)) {
        checklist = { ...checklist, items: [...checklist.items, { id: blockerId, text: redactSecrets(decision.summary).slice(0, 8_000), source: 'reviewer',
          status: 'open', introducedBy: currentPlanFingerprint, resolvedBy: null, evidence: [`Blocked by ${model} review of plan ${plan.id}.`] }] };
      }
      persistChecklist(this.store, taskId, cloud.attemptId ?? null, cloud.baseSha, checklist);
      if (repeatedBlockers >= STAGNANT_BLOCK_CYCLES) {
        this.store.addEvent(taskId, 'orchestra', 'cloud.tier_escalated', { from: model, to: model === 'gpt-5.6-luna' ? 'gpt-5.6-terra' : model,
          reason: `The same blocker set persisted for ${repeatedBlockers} plans; the next unique revision receives a consolidated higher-tier review.` });
      }

      const feedback = [
        'Local Orchestra plan review blocked this plan. Revise the plan before implementation and wait for approval again.',
        repeatedBlockers >= STAGNANT_BLOCK_CYCLES ? `Consolidated correction packet (same blockers repeated ${repeatedBlockers} times):\n${redactSecrets(decision.summary).slice(0, 8_000)}` : redactSecrets(decision.summary).slice(0, 8_000),
      ].join('\n\n');
      this.store.manager.leases.assertFence('jules_plan_review', cloud.id, ownerId, lease.fencingToken);
      await this.sessions.sendMessage(taskId, feedback, `auto-plan-feedback:${taskId}:${plan.id}`);
      this.store.manager.checkpoints.append({ taskId, attemptId: cloud.attemptId, stage: 'jules_plan_review', subjectSha: cloud.baseSha,
        data: { status: 'feedback_sent', planId: plan.id, verdict: 'BLOCK', revisions: nextRevision,
          planFingerprint: currentPlanFingerprint, blockerFingerprint: blockerFingerprint(decision.summary), repeatedBlockers, model, effort: route.effort } });
      return { status: 'feedback_sent', planId: plan.id, verdict: 'BLOCK' };
    } catch (error) {
      try {
        this.store.manager.leases.assertFence('jules_plan_review', cloud.id, ownerId, lease.fencingToken);
      } catch {
        return { status: 'stale', planId: plan.id };
      }
      if (providerRunId) this.store.finishProviderRun(providerRunId, 'failed');
      const message = error instanceof Error ? error.message : String(error);
      if (retryableCodexFailure(error)) {
        const priorRetries = this.store.listEvents(taskId).filter((event) => event.type === 'warning'
          && event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
          && (event.payload as Record<string, unknown>).code === 'JULES_PLAN_REVIEW_RETRY'
          && (event.payload as Record<string, unknown>).planId === plan.id).length;
        const retryDelayMs = Math.min(REVIEW_RETRY_MAX_MS, REVIEW_RETRY_BASE_MS * (2 ** Math.min(priorRetries, 5)));
        const retryAt = new Date(Date.now() + retryDelayMs).toISOString();
        const retryMessage = `Automatic Jules plan review is temporarily unavailable and will retry in ${Math.ceil(retryDelayMs / 60_000)} minute(s): ${message}`;
        this.store.manager.checkpoints.append({ taskId, attemptId: cloud.attemptId, stage: 'jules_plan_review', subjectSha: cloud.baseSha,
          data: { status: 'retry_waiting', planId: plan.id, error: redactSecrets(message).slice(0, 2_000), retryAt, retryCount: priorRetries + 1 } });
        this.store.updateTask(taskId, { state: 'running', error: retryMessage });
        this.store.addEvent(taskId, 'orchestra', 'warning', { code: 'JULES_PLAN_REVIEW_RETRY', planId: plan.id, message: retryMessage,
          nextAction: 'No manual approval or duplicate dispatch is needed. Orchestra will retry the exact plan automatically.' });
        return { status: 'retry_waiting', planId: plan.id };
      }
      this.store.manager.checkpoints.append({ taskId, attemptId: cloud.attemptId, stage: 'jules_plan_review', subjectSha: cloud.baseSha,
        data: { status: 'failed', planId: plan.id, error: redactSecrets(message).slice(0, 2_000) } });
      this.store.updateTask(taskId, { state: 'review_disputed', error: `Automatic Jules plan review failed: ${message}` });
      this.store.addEvent(taskId, 'orchestra', 'warning', { code: 'JULES_PLAN_REVIEW_FAILED', message: `Automatic Jules plan review failed: ${message}`,
        nextAction: 'Inspect the plan-review error; Orchestra did not approve the plan.' });
      return { status: 'failed', planId: plan.id };
    } finally {
      this.store.manager.leases.release('jules_plan_review', cloud.id, ownerId, lease.fencingToken);
    }
  }
}
