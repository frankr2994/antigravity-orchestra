import { createHash, randomUUID } from 'node:crypto';
import type { Store } from '../../db.js';
import type { JulesAutomationStatus, JulesHandoffDecision, JulesHandoffKind, JulesHandoffModel } from '../../domain/index.js';
import { JulesHandoffResolver, type JulesHandoffResolution, type JulesHandoffResolverPort } from './handoff-resolver.js';

interface PlanGate { reconcile(taskId: string): Promise<{ status: string; planId?: string; verdict?: 'PASS' | 'BLOCK' }> }
interface FinalGate { reviewAndIntegrate(taskId: string): Promise<Record<string, unknown>> }
interface MessageSessionPort { sendMessage(taskId: string, prompt: string, idempotencyKey: string): Promise<unknown> }

type AttentionStatus = 'resolving' | 'response_ready' | 'awaiting_resume' | 'resumed' | 'retry_waiting' | 'blocked';
interface AttentionCheckpoint {
  version: 1;
  attentionId: string;
  questionFingerprint: string;
  status: AttentionStatus;
  response: string | null;
  responseFingerprint: string | null;
  commandKey: string | null;
  sentAfterEventId: number | null;
  attempt: number;
  handler: JulesAutomationStatus['handler'];
  model: JulesAutomationStatus['model'];
  effort: string | null;
  reason: string;
  retryAt: string | null;
  updatedAt: string;
}

interface Attention { id: string; eventId: number; question: string }

const RESOLUTION_TIMEOUT_MS = 4 * 60_000;
const HANDOFF_LEASE_MS = 6 * 60_000;
const RESUME_GRACE_MS = 2 * 60_000;
const RETRY_BASE_MS = 60_000;

function fingerprint(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function completionSummary(store: Store, taskId: string, afterEventId: number): string | null {
  const event = store.listEvents(taskId).findLast((item) => item.id >= afterEventId && item.type === 'cloud.activity'
    && isRecord(item.payload) && item.payload.kind === 'completed');
  const payload = isRecord(event?.payload) ? event.payload as unknown as Record<string, unknown> : null;
  const summary = payload?.summary;
  return typeof summary === 'string' && summary.trim() ? summary.slice(0, 8_000) : null;
}

function latestAttention(store: Store, taskId: string): Attention {
  const event = store.listEvents(taskId).findLast((item) => item.type === 'cloud.activity'
    && isRecord(item.payload) && item.payload.kind === 'agent_message');
  const payload: Record<string, unknown> = isRecord(event?.payload)
    ? event.payload as unknown as Record<string, unknown> : {};
  const question = typeof payload.message === 'string' ? payload.message.slice(0, 12_000) : '';
  const providerId = typeof payload.providerActivityId === 'string' && payload.providerActivityId
    ? payload.providerActivityId : `event-${event?.id ?? 0}`;
  return { id: providerId, eventId: event?.id ?? 0, question };
}

function parseAttentionCheckpoint(value: unknown): AttentionCheckpoint {
  if (!isRecord(value) || value.version !== 1) throw new Error('Persisted Jules attention handoff is malformed.');
  const statuses: AttentionStatus[] = ['resolving', 'response_ready', 'awaiting_resume', 'resumed', 'retry_waiting', 'blocked'];
  if (typeof value.attentionId !== 'string' || !value.attentionId || !statuses.includes(value.status as AttentionStatus)) {
    throw new Error('Persisted Jules attention identity or status is malformed.');
  }
  const nullableString = (field: unknown) => {
    if (field === null) return null;
    if (typeof field === 'string') return field;
    throw new Error('Persisted Jules attention string is malformed.');
  };
  if (typeof value.questionFingerprint !== 'string' || typeof value.attempt !== 'number'
    || !Number.isSafeInteger(value.attempt) || value.attempt < 0) {
    throw new Error('Persisted Jules attention fingerprint or attempt is malformed.');
  }
  if (value.sentAfterEventId !== null && (!Number.isSafeInteger(value.sentAfterEventId) || Number(value.sentAfterEventId) < 0)) {
    throw new Error('Persisted Jules attention event cursor is malformed.');
  }
  return {
    version: 1, attentionId: value.attentionId, questionFingerprint: value.questionFingerprint,
    status: value.status as AttentionStatus, response: nullableString(value.response),
    responseFingerprint: nullableString(value.responseFingerprint), commandKey: nullableString(value.commandKey),
    sentAfterEventId: value.sentAfterEventId === null ? null : Number(value.sentAfterEventId), attempt: value.attempt,
    handler: value.handler === null ? null : String(value.handler) as AttentionCheckpoint['handler'],
    model: value.model === null ? null : String(value.model) as AttentionCheckpoint['model'],
    effort: nullableString(value.effort), reason: typeof value.reason === 'string' ? value.reason : '',
    retryAt: nullableString(value.retryAt), updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
  };
}

function deterministicResponse(summary: string | null, state: string, question: string): JulesHandoffResolution | null {
  if (summary) return {
    response: 'Your implementation summary was received. Run the final deterministic checks, fix any failures, update or create the pull request, and complete the Jules session with the final PR output.',
    handler: 'deterministic', model: null, effort: 'none',
    reason: 'A completion summary followed by an attention state has a deterministic continuation.',
    tokenUsage: null, escalationHistory: [],
  };
  if (state === 'PAUSED' && !question.trim()) return {
    response: 'Resume the original task within its existing authority. Continue implementation, run the required checks, update or create the pull request, and complete the session. Stop only for credentials, destructive out-of-scope operations, or an authority conflict.',
    handler: 'deterministic', model: null, effort: 'none',
    reason: 'A provider pause without a technical question has a deterministic continuation.',
    tokenUsage: null, escalationHistory: [],
  };
  if (/\b(?:may i|should i|shall i|can i)\s+(?:continue|proceed|keep going)\b/i.test(question)) return {
    response: 'Yes. Continue with the smallest safe in-scope implementation, run the repository checks, update or create the pull request, and complete the Jules session. Do not wait for further confirmation unless credentials, destructive out-of-scope action, or new authority is required.',
    handler: 'deterministic', model: null, effort: 'none',
    reason: 'A simple request for permission to continue has a deterministic answer.',
    tokenUsage: null, escalationHistory: [],
  };
  return null;
}

export class JulesHandoffService {
  private readonly ownerId = `jules-handoff-${randomUUID()}`;

  constructor(
    private readonly store: Store,
    private readonly sessions: MessageSessionPort,
    private readonly planGate: PlanGate,
    private readonly finalGate: FinalGate,
    private readonly options: { resolver?: JulesHandoffResolverPort; now?: () => Date; resumeGraceMs?: number } = {},
  ) {}

  async reconcile(taskId: string): Promise<Record<string, unknown>> {
    const task = this.store.getTask(taskId);
    const cloud = this.store.manager.cloudSessions.getByTaskId(taskId);
    if (!task || !cloud) return { status: 'not_found' };
    const resumed = this.reconcileProviderResume(taskId, cloud.state);
    if (resumed) return resumed;
    if (cloud.state === 'AWAITING_PLAN_APPROVAL') return this.planGate.reconcile(taskId);
    if (cloud.state === 'AWAITING_USER_FEEDBACK' || cloud.state === 'PAUSED') {
      return this.reconcileAttention(taskId, cloud.state === 'PAUSED' ? 'paused' : 'user_feedback');
    }
    if (cloud.state === 'COMPLETED') {
      this.persistStatus(taskId, 'provider_completed', 'deterministic', null, 'Provider completion is distinct from local review completion.', null, 'none');
      if (!cloud.prUrl) return { status: 'waiting_for_pr' };
      return this.finalGate.reviewAndIntegrate(taskId);
    }
    return { status: 'no_attention', state: cloud.state };
  }

  private reconcileProviderResume(taskId: string, providerState: string): Record<string, unknown> | null {
    const latest = this.readAttentionCheckpoint(taskId);
    if (!latest || latest.status !== 'awaiting_resume') return null;
    const laterAgentActivity = this.store.listEvents(taskId).some((event) => event.id > (latest.sentAfterEventId ?? Number.MAX_SAFE_INTEGER)
      && event.type === 'cloud.activity' && isRecord(event.payload) && event.payload.originator === 'agent');
    const attentionState = providerState === 'AWAITING_USER_FEEDBACK' || providerState === 'PAUSED';
    if (attentionState && !laterAgentActivity) return null;
    this.persistAttention(taskId, { ...latest, status: 'resumed', retryAt: null, updatedAt: this.now().toISOString() });
    this.persistStatus(taskId, 'provider_resumed', latest.handler, latest.model,
      'Jules produced later agent activity or left the attention state after Orchestra guidance.', null, latest.effort);
    this.store.addEvent(taskId, 'orchestra', 'cloud.resume_confirmed', {
      attentionId: latest.attentionId, providerState, laterAgentActivity,
    });
    const currentAttention = latestAttention(this.store, taskId);
    // If the activity that proved resumption is a new clarification, resolve it
    // in this same controller turn instead of waiting for another supervisor tick.
    return attentionState && currentAttention.id !== latest.attentionId
      ? null
      : { status: 'provider_resumed', providerState };
  }

  private async reconcileAttention(taskId: string, kind: JulesHandoffKind): Promise<Record<string, unknown>> {
    const task = this.store.getTask(taskId)!;
    const project = this.store.getProject(task.projectId)!;
    const cloud = this.store.manager.cloudSessions.getByTaskId(taskId)!;
    const attention = latestAttention(this.store, taskId);
    const summary = completionSummary(this.store, taskId, attention.eventId);
    if (/\b(?:credential|password|api key|secret|delete repository|force push|different repository|purchase|payment)\b/i.test(attention.question)) {
      const resolution: JulesHandoffResolution = {
        response: '', handler: 'deterministic', model: null, effort: 'none',
        reason: 'The provider request requires credentials, destructive action, external spending, or authority outside the original task.',
        tokenUsage: null, escalationHistory: [],
      };
      this.persistDecision(taskId, kind, resolution, 'block', null);
      this.persistAttention(taskId, this.checkpoint(attention, 'blocked', resolution));
      this.persistStatus(taskId, 'blocked', resolution.handler, resolution.model, resolution.reason, null, resolution.effort);
      return { status: 'authority_blocked' };
    }

    const prior = this.readAttentionCheckpoint(taskId);
    if (prior?.attentionId === attention.id) {
      if (prior.status === 'awaiting_resume') {
        const retryAt = prior.retryAt ? Date.parse(prior.retryAt) : Number.POSITIVE_INFINITY;
        if (retryAt > this.now().getTime()) return { status: 'awaiting_provider_resume', retryAt: prior.retryAt };
        if (prior.attempt >= 2) {
          const nextRetry = new Date(this.now().getTime() + 10 * RETRY_BASE_MS).toISOString();
          const waiting = { ...prior, status: 'retry_waiting' as const, retryAt: nextRetry, updatedAt: this.now().toISOString() };
          this.persistAttention(taskId, waiting);
          this.persistStatus(taskId, 'waiting', prior.handler, prior.model,
            'Jules accepted two bounded continuation messages but has not produced later agent activity; Orchestra will keep polling without creating a message storm.', nextRetry, prior.effort);
          this.store.addEvent(taskId, 'orchestra', 'cloud.handoff_retry_waiting', {
            attentionId: attention.id, retryAt: nextRetry, attempts: prior.attempt,
          });
          return { status: 'retry_waiting', retryAt: nextRetry };
        }
        const retryResponse = `${prior.response}\n\nThe previous guidance was recorded but no later agent activity was observed. Resume implementation now and do not wait for another confirmation.`;
        return this.sendResolvedAttention(taskId, kind, attention, {
          response: retryResponse.slice(0, 12_000), handler: prior.handler || 'deterministic', model: prior.model,
          effort: (prior.effort || 'none') as JulesHandoffResolution['effort'],
          reason: `${prior.reason} Bounded resume retry after no provider progress.`, tokenUsage: null, escalationHistory: [],
        }, prior.attempt + 1);
      }
      if (prior.status === 'response_ready' && prior.retryAt && Date.parse(prior.retryAt) > this.now().getTime()) {
        return { status: 'response_delivery_retry_waiting', retryAt: prior.retryAt };
      }
      if (prior.status === 'response_ready') return this.sendResolvedAttention(taskId, kind, attention, {
        response: prior.response!, handler: prior.handler!, model: prior.model,
        effort: (prior.effort || 'none') as JulesHandoffResolution['effort'], reason: prior.reason,
        tokenUsage: null, escalationHistory: [],
      }, Math.max(1, prior.attempt));
      if (prior.status === 'resolving' && this.now().getTime() - Date.parse(prior.updatedAt) < RESOLUTION_TIMEOUT_MS) {
        return { status: 'resolving' };
      }
      if (prior.status === 'retry_waiting' && prior.retryAt && Date.parse(prior.retryAt) > this.now().getTime()) {
        return { status: 'retry_waiting', retryAt: prior.retryAt };
      }
    }

    const lease = this.store.manager.leases.acquire('jules_handoff', cloud.id, this.ownerId, HANDOFF_LEASE_MS);
    if (!lease) return { status: 'leased' };
    try {
      const again = this.readAttentionCheckpoint(taskId);
      if (again?.attentionId === attention.id && ['response_ready', 'awaiting_resume'].includes(again.status)) {
        return { status: again.status };
      }
      const resolutionAttempt = again?.attentionId === attention.id ? Math.max(1, again.attempt + 1) : 1;
      const resolving: AttentionCheckpoint = this.checkpoint(attention, 'resolving', null, resolutionAttempt);
      this.persistAttention(taskId, resolving);
      let resolution = deterministicResponse(summary, cloud.state, attention.question);
      if (!resolution) {
        const resolver = this.options.resolver || new JulesHandoffResolver();
        try {
          const orphanedRun = this.store.manager.providerRuns.findRunning(taskId, 'codex');
          if (orphanedRun?.operation === 'jules_handoff') this.store.finishProviderRun(orphanedRun.id, 'failed');
          const run = this.store.startProviderRun({ taskId, provider: 'codex', operation: 'jules_handoff', model: 'gpt-5.6-luna', primaryWorker: false });
          try {
            resolution = await resolver.resolve({
              kind, projectRoot: project.root, originalRequest: task.prompt, question: attention.question,
              signal: AbortSignal.timeout(RESOLUTION_TIMEOUT_MS),
              onOutput: (chunk) => this.store.addEvent(taskId, 'codex', 'agent.output', { role: 'jules-handoff', text: chunk.slice(0, 4_000) }),
              onUsage: (usage) => this.store.addEvent(taskId, 'codex', 'provider.telemetry', { role: 'jules-handoff', usage }),
            });
            this.store.finishProviderRun(run.id, 'completed');
          } catch (error) {
            this.store.finishProviderRun(run.id, 'failed');
            throw error;
          }
        } catch (error) {
          const retryDelay = Math.min(15 * RETRY_BASE_MS, RETRY_BASE_MS * (2 ** Math.min(resolutionAttempt - 1, 4)));
          const retryAt = new Date(this.now().getTime() + retryDelay).toISOString();
          const message = error instanceof Error ? error.message : String(error);
          this.persistAttention(taskId, {
            ...resolving, status: 'retry_waiting', reason: message.slice(0, 2_000), retryAt, updatedAt: this.now().toISOString(),
          });
          this.persistStatus(taskId, 'waiting', null, null,
            'The technical handoff resolver is temporarily unavailable; Orchestra will retry automatically.', retryAt);
          this.store.addEvent(taskId, 'orchestra', 'cloud.handoff_retry_waiting', {
            attentionId: attention.id, retryAt, attempt: resolutionAttempt, error: message.slice(0, 1_000),
          });
          return { status: 'retry_waiting', retryAt };
        }
      }
      if (resolution.response.startsWith('AUTHORITY_BLOCK:')) {
        this.persistDecision(taskId, kind, resolution, 'block', null);
        this.persistAttention(taskId, this.checkpoint(attention, 'blocked', resolution));
          this.persistStatus(taskId, 'blocked', resolution.handler, resolution.model,
          resolution.response.slice('AUTHORITY_BLOCK:'.length).trim(), null, resolution.effort);
        return { status: 'authority_blocked' };
      }
      this.store.manager.leases.assertFence('jules_handoff', cloud.id, this.ownerId, lease.fencingToken);
      return await this.sendResolvedAttention(taskId, kind, attention, resolution, 1);
    } finally {
      this.store.manager.leases.release('jules_handoff', cloud.id, this.ownerId, lease.fencingToken);
    }
  }

  private async sendResolvedAttention(
    taskId: string,
    kind: JulesHandoffKind,
    attention: Attention,
    resolution: JulesHandoffResolution,
    attempt: number,
  ) {
    const responseFingerprint = fingerprint(resolution.response);
    const commandKey = `auto-handoff:${taskId}:${attention.id}:${attempt}:${responseFingerprint}`;
    const sentAfterEventId = this.store.listEvents(taskId).at(-1)?.id ?? attention.eventId;
    this.persistDecision(taskId, kind, resolution, 'respond', resolution.response);
    this.persistAttention(taskId, this.checkpoint(attention, 'response_ready', resolution, attempt, {
      commandKey, sentAfterEventId, retryAt: null,
    }));
    try {
      await this.sessions.sendMessage(taskId, resolution.response, commandKey);
    } catch (error) {
      const retryAt = new Date(this.now().getTime() + RETRY_BASE_MS).toISOString();
      const message = error instanceof Error ? error.message : String(error);
      this.persistAttention(taskId, this.checkpoint(attention, 'response_ready', resolution, attempt, {
        commandKey, sentAfterEventId, retryAt,
      }));
      this.persistStatus(taskId, 'waiting', resolution.handler, resolution.model,
        'The Jules response delivery is unconfirmed; Orchestra will reconcile the same durable command before sending anything else.', retryAt, resolution.effort);
      this.store.addEvent(taskId, 'orchestra', 'cloud.handoff_retry_waiting', {
        attentionId: attention.id, commandKey, retryAt, attempt, error: message.slice(0, 1_000),
      });
      return { status: 'response_delivery_retry_waiting', retryAt };
    }
    const retryAt = new Date(this.now().getTime() + (this.options.resumeGraceMs ?? RESUME_GRACE_MS)).toISOString();
    const checkpoint = this.checkpoint(attention, 'awaiting_resume', resolution, attempt, {
      commandKey, sentAfterEventId, retryAt,
    });
    this.persistAttention(taskId, checkpoint);
    this.persistStatus(taskId, 'awaiting_provider_resume', resolution.handler, resolution.model,
      'The guidance was recorded by Jules; Orchestra is waiting for later agent activity or a provider state transition before considering the handoff resumed.', retryAt, resolution.effort);
    this.store.addEvent(taskId, 'orchestra', 'cloud.auto_responded', {
      kind, attentionId: attention.id, handler: resolution.handler, model: resolution.model,
      effort: resolution.effort, attempt, responseFingerprint,
    });
    this.store.addEvent(taskId, 'orchestra', 'cloud.awaiting_resume', {
      attentionId: attention.id, commandKey, retryAt, attempt,
    });
    return { status: 'awaiting_provider_resume', handler: resolution.handler, model: resolution.model, retryAt };
  }

  private checkpoint(
    attention: Attention,
    status: AttentionStatus,
    resolution: JulesHandoffResolution | null,
    attempt = 0,
    fields: Partial<Pick<AttentionCheckpoint, 'commandKey' | 'sentAfterEventId' | 'retryAt'>> = {},
  ): AttentionCheckpoint {
    return {
      version: 1, attentionId: attention.id, questionFingerprint: fingerprint(attention.question), status,
      response: resolution?.response || null,
      responseFingerprint: resolution?.response ? fingerprint(resolution.response) : null,
      commandKey: fields.commandKey ?? null, sentAfterEventId: fields.sentAfterEventId ?? null, attempt,
      handler: resolution?.handler ?? null, model: resolution?.model ?? null, effort: resolution?.effort ?? null,
      reason: resolution?.reason || '', retryAt: fields.retryAt ?? null, updatedAt: this.now().toISOString(),
    };
  }

  private readAttentionCheckpoint(taskId: string): AttentionCheckpoint | null {
    const checkpoint = this.store.manager.checkpoints.latest(taskId, 'jules_attention_handoff');
    return checkpoint ? parseAttentionCheckpoint(checkpoint.data) : null;
  }

  private persistAttention(taskId: string, value: AttentionCheckpoint) {
    const cloud = this.store.manager.cloudSessions.getByTaskId(taskId)!;
    this.store.manager.checkpoints.append({
      taskId, attemptId: cloud.attemptId, stage: 'jules_attention_handoff',
      subjectSha: cloud.prHeadSha || cloud.baseSha, data: value as unknown as Record<string, unknown>,
    });
  }

  private persistDecision(
    taskId: string,
    kind: JulesHandoffKind,
    resolution: JulesHandoffResolution,
    outcome: JulesHandoffDecision['outcome'],
    response: string | null,
  ) {
    const task = this.store.getTask(taskId)!;
    const cloud = this.store.manager.cloudSessions.getByTaskId(taskId)!;
    const promptFingerprint = fingerprint({ kind, prompt: task.prompt, state: cloud.state, response });
    const decision: JulesHandoffDecision = {
      version: 1, kind, handler: resolution.handler, model: resolution.model, effort: resolution.effort,
      reason: resolution.reason, promptFingerprint,
      decisionFingerprint: fingerprint({ kind, handler: resolution.handler, model: resolution.model, effort: resolution.effort, outcome, response }),
      tokenUsage: resolution.tokenUsage, escalationHistory: resolution.escalationHistory,
      outcome, response, createdAt: this.now().toISOString(),
    };
    const prior = this.store.manager.checkpoints.latest(taskId, 'jules_handoff_decision');
    if (prior?.data.decisionFingerprint === decision.decisionFingerprint) return;
    this.store.manager.transaction(() => {
      this.store.manager.checkpoints.append({
        taskId, attemptId: cloud.attemptId, stage: 'jules_handoff_decision',
        subjectSha: cloud.prHeadSha || cloud.baseSha, data: decision as unknown as Record<string, unknown>,
      });
      this.store.addEvent(taskId, 'orchestra', 'cloud.handoff_classified', {
        kind, handler: resolution.handler, model: resolution.model, effort: resolution.effort,
        reason: resolution.reason, promptFingerprint,
      });
    });
  }

  private persistStatus(
    taskId: string,
    state: JulesAutomationStatus['state'],
    handler: JulesAutomationStatus['handler'],
    model: JulesHandoffModel,
    reason: string,
    retryAt: string | null = null,
    effort: string | null = null,
  ) {
    const task = this.store.getTask(taskId)!;
    const cloud = this.store.manager.cloudSessions.getByTaskId(taskId)!;
    const status: JulesAutomationStatus = {
      version: 1, state, handler, model, effort, reason, pendingCommand: null,
      retryAt, authoritativeTaskState: task.state, updatedAt: this.now().toISOString(),
    };
    this.store.manager.checkpoints.append({
      taskId, attemptId: cloud.attemptId, stage: 'jules_automation',
      subjectSha: cloud.prHeadSha || cloud.baseSha, data: status as unknown as Record<string, unknown>,
    });
  }

  private now() { return this.options.now?.() ?? new Date(); }
}
