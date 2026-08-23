import type {
  BaseJulesActivity,
  JulesActivity,
  JulesArtifact,
  JulesListActivitiesResponse,
  JulesListSessionsResponse,
  JulesListSourcesResponse,
  JulesPlan,
  JulesSession,
  JulesSessionOutput,
  JulesSource,
  UnknownJulesSessionState,
} from './types.js';
import type { JulesSessionState } from './state-mapper.js';

const MAX_TEXT_LENGTH = 1_000_000;
const MAX_COLLECTION_LENGTH = 1_000;
const SESSION_STATES = new Set<JulesSessionState>([
  'STATE_UNSPECIFIED',
  'QUEUED',
  'PLANNING',
  'AWAITING_PLAN_APPROVAL',
  'AWAITING_USER_FEEDBACK',
  'IN_PROGRESS',
  'PAUSED',
  'COMPLETED',
  'FAILED',
]);
const ORIGINATORS = new Set(['user', 'agent', 'system']);
const ACTIVITY_VARIANTS = [
  'planGenerated',
  'planApproved',
  'userMessaged',
  'agentMessaged',
  'progressUpdated',
  'sessionCompleted',
  'sessionFailed',
] as const;
const ACTIVITY_BASE_FIELDS = new Set(['name', 'id', 'originator', 'description', 'createTime', 'artifacts']);

export class JulesContractError extends Error {
  readonly code = 'JULES_CONTRACT_INVALID';

  constructor(readonly path: string, message: string) {
    super(`Invalid Jules response at ${path}: ${message}`);
    this.name = 'JulesContractError';
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new JulesContractError(path, 'expected an object');
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, path: string, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value || value.length > MAX_TEXT_LENGTH) {
    throw new JulesContractError(path, `expected a non-empty string of at most ${MAX_TEXT_LENGTH} characters`);
  }
  return value;
}

function booleanValue(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new JulesContractError(path, 'expected a boolean');
  return value;
}

function numberValue(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new JulesContractError(path, 'expected a finite number');
  return value;
}

function arrayValue(value: unknown, path: string, required = true): unknown[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value)) throw new JulesContractError(path, 'expected an array');
  if (value.length > MAX_COLLECTION_LENGTH) throw new JulesContractError(path, `exceeds ${MAX_COLLECTION_LENGTH} items`);
  return value;
}

function resourceName(value: unknown, path: string, pattern: RegExp): string {
  const result = stringValue(value, path)!;
  if (!pattern.test(result)) throw new JulesContractError(path, 'has an invalid resource-name format');
  return result;
}

function optionalTimestamp(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  const result = stringValue(value, path)!;
  if (!Number.isFinite(Date.parse(result))) throw new JulesContractError(path, 'expected an RFC 3339 timestamp');
  return result;
}

function parseBranch(value: unknown, path: string): { displayName: string } {
  const input = record(value, path);
  return { displayName: stringValue(input.displayName, `${path}.displayName`)! };
}

export function parseJulesSource(value: unknown, path = '$'): JulesSource {
  const input = record(value, path);
  const githubRepo = input.githubRepo === undefined ? undefined : record(input.githubRepo, `${path}.githubRepo`);
  return {
    name: resourceName(input.name, `${path}.name`, /^sources\/[^\s]+$/),
    id: stringValue(input.id, `${path}.id`, false),
    githubRepo: githubRepo ? {
      owner: stringValue(githubRepo.owner, `${path}.githubRepo.owner` )!,
      repo: stringValue(githubRepo.repo, `${path}.githubRepo.repo` )!,
      defaultBranch: githubRepo.defaultBranch === undefined ? undefined : parseBranch(githubRepo.defaultBranch, `${path}.githubRepo.defaultBranch`),
      branches: githubRepo.branches === undefined
        ? undefined
        : arrayValue(githubRepo.branches, `${path}.githubRepo.branches`).map((item, index) => parseBranch(item, `${path}.githubRepo.branches[${index}]`)),
    } : undefined,
  };
}

export function parseJulesListSourcesResponse(value: unknown): JulesListSourcesResponse {
  const input = record(value, '$');
  return {
    sources: arrayValue(input.sources, '$.sources').map((item, index) => parseJulesSource(item, `$.sources[${index}]`)),
    nextPageToken: stringValue(input.nextPageToken, '$.nextPageToken', false),
  };
}

function parsePullRequest(value: unknown, path: string) {
  const input = record(value, path);
  return {
    url: stringValue(input.url, `${path}.url`, false),
    title: stringValue(input.title, `${path}.title`, false),
    description: stringValue(input.description, `${path}.description`, false),
  };
}

function parseSessionOutput(value: unknown, path: string): JulesSessionOutput {
  const input = record(value, path);
  if (input.pullRequest !== undefined) {
    return { kind: 'pullRequest', pullRequest: parsePullRequest(input.pullRequest, `${path}.pullRequest`) };
  }
  return { kind: 'unknown', unknownFields: Object.keys(input).sort() };
}

export function parseJulesSession(value: unknown, path = '$'): JulesSession {
  const input = record(value, path);
  const rawState = stringValue(input.state, `${path}.state`)!;
  const sourceContext = input.sourceContext === undefined ? undefined : record(input.sourceContext, `${path}.sourceContext`);
  const githubContext = sourceContext?.githubRepoContext === undefined
    ? undefined
    : record(sourceContext.githubRepoContext, `${path}.sourceContext.githubRepoContext`);
  const automationMode = stringValue(input.automationMode, `${path}.automationMode`, false);
  if (automationMode !== undefined && automationMode !== 'AUTOMATION_MODE_UNSPECIFIED' && automationMode !== 'AUTO_CREATE_PR') {
    throw new JulesContractError(`${path}.automationMode`, 'contains an unknown automation mode');
  }
  return {
    name: resourceName(input.name, `${path}.name`, /^sessions\/[^/\s]+$/),
    id: stringValue(input.id, `${path}.id`, false),
    title: stringValue(input.title, `${path}.title`, false),
    state: SESSION_STATES.has(rawState as JulesSessionState)
      ? rawState as JulesSessionState
      : rawState as UnknownJulesSessionState,
    sourceContext: sourceContext ? {
      source: resourceName(sourceContext.source, `${path}.sourceContext.source`, /^sources\/[^\s]+$/),
      githubRepoContext: githubContext ? {
        startingBranch: stringValue(githubContext.startingBranch, `${path}.sourceContext.githubRepoContext.startingBranch`, false),
      } : undefined,
    } : undefined,
    prompt: stringValue(input.prompt, `${path}.prompt`, false),
    requirePlanApproval: booleanValue(input.requirePlanApproval, `${path}.requirePlanApproval`),
    automationMode: automationMode as JulesSession['automationMode'],
    outputs: input.outputs === undefined
      ? undefined
      : arrayValue(input.outputs, `${path}.outputs`).map((item, index) => parseSessionOutput(item, `${path}.outputs[${index}]`)),
    createTime: optionalTimestamp(input.createTime, `${path}.createTime`),
    updateTime: optionalTimestamp(input.updateTime, `${path}.updateTime`),
  };
}

export function parseJulesListSessionsResponse(value: unknown): JulesListSessionsResponse {
  const input = record(value, '$');
  return {
    sessions: arrayValue(input.sessions, '$.sessions').map((item, index) => parseJulesSession(item, `$.sessions[${index}]`)),
    nextPageToken: stringValue(input.nextPageToken, '$.nextPageToken', false),
  };
}

function parsePlan(value: unknown, path: string): JulesPlan {
  const input = record(value, path);
  return {
    id: stringValue(input.id, `${path}.id`, false),
    steps: arrayValue(input.steps, `${path}.steps`).map((item, index) => {
      const step = record(item, `${path}.steps[${index}]`);
      return {
        index: numberValue(step.index, `${path}.steps[${index}].index`),
        title: stringValue(step.title, `${path}.steps[${index}].title` )!,
        description: stringValue(step.description, `${path}.steps[${index}].description`, false),
        status: stringValue(step.status, `${path}.steps[${index}].status`, false),
      };
    }),
  };
}

function parseArtifact(value: unknown, path: string): JulesArtifact {
  const input = record(value, path);
  const artifact: JulesArtifact = {};
  if (input.changeSet !== undefined) {
    const changeSet = record(input.changeSet, `${path}.changeSet`);
    const gitPatch = changeSet.gitPatch === undefined ? undefined : record(changeSet.gitPatch, `${path}.changeSet.gitPatch`);
    artifact.changeSet = {
      source: stringValue(changeSet.source, `${path}.changeSet.source`, false),
      gitPatch: gitPatch ? {
        patch: stringValue(gitPatch.patch, `${path}.changeSet.gitPatch.patch`, false),
        uncommittedChanges: booleanValue(gitPatch.uncommittedChanges, `${path}.changeSet.gitPatch.uncommittedChanges`),
        mimeType: stringValue(gitPatch.mimeType, `${path}.changeSet.gitPatch.mimeType`, false),
      } : undefined,
    };
  }
  if (input.bashOutput !== undefined) {
    const bash = record(input.bashOutput, `${path}.bashOutput`);
    artifact.bashOutput = {
      command: stringValue(bash.command, `${path}.bashOutput.command`, false),
      output: stringValue(bash.output, `${path}.bashOutput.output`, false),
      exitCode: numberValue(bash.exitCode, `${path}.bashOutput.exitCode`),
    };
  }
  if (input.media !== undefined) {
    const media = record(input.media, `${path}.media`);
    artifact.media = {
      mimeType: stringValue(media.mimeType, `${path}.media.mimeType`, false),
      data: stringValue(media.data, `${path}.media.data`, false),
    };
  }
  return artifact;
}

export function parseJulesActivity(value: unknown, path = '$'): JulesActivity {
  const input = record(value, path);
  const originator = stringValue(input.originator, `${path}.originator`, false);
  if (originator !== undefined && !ORIGINATORS.has(originator)) {
    throw new JulesContractError(`${path}.originator`, 'contains an unknown originator');
  }
  const base: BaseJulesActivity = {
    name: resourceName(input.name, `${path}.name`, /^sessions\/[^/\s]+\/activities\/[^/\s]+$/),
    id: stringValue(input.id, `${path}.id`, false),
    createTime: optionalTimestamp(input.createTime, `${path}.createTime`),
    originator: originator as BaseJulesActivity['originator'],
    description: stringValue(input.description, `${path}.description`, false),
    artifacts: input.artifacts === undefined
      ? undefined
      : arrayValue(input.artifacts, `${path}.artifacts`).map((item, index) => parseArtifact(item, `${path}.artifacts[${index}]`)),
  };
  const variants = ACTIVITY_VARIANTS.filter((key) => input[key] !== undefined);
  if (variants.length > 1) throw new JulesContractError(path, 'contains multiple activity variants');
  const variant = variants[0];
  if (!variant) {
    const fields = Object.keys(input).filter((key) => !ACTIVITY_BASE_FIELDS.has(key)).sort();
    return { ...base, unknownActivity: { fields } };
  }
  const payload = record(input[variant], `${path}.${variant}`);
  switch (variant) {
    case 'planGenerated':
      return { ...base, planGenerated: { plan: payload.plan === undefined ? undefined : parsePlan(payload.plan, `${path}.planGenerated.plan`) } };
    case 'planApproved':
      return { ...base, planApproved: { planId: stringValue(payload.planId, `${path}.planApproved.planId`, false) } };
    case 'userMessaged':
      return { ...base, userMessaged: { userMessage: stringValue(payload.userMessage, `${path}.userMessaged.userMessage`)! } };
    case 'agentMessaged':
      return { ...base, agentMessaged: { agentMessage: stringValue(payload.agentMessage, `${path}.agentMessaged.agentMessage`)! } };
    case 'progressUpdated':
      return { ...base, progressUpdated: {
        title: stringValue(payload.title, `${path}.progressUpdated.title`, false),
        description: stringValue(payload.description, `${path}.progressUpdated.description`, false),
      } };
    case 'sessionCompleted':
      return { ...base, sessionCompleted: {} };
    case 'sessionFailed':
      return { ...base, sessionFailed: { reason: stringValue(payload.reason, `${path}.sessionFailed.reason`, false) } };
  }
}

export function parseJulesListActivitiesResponse(value: unknown): JulesListActivitiesResponse {
  const input = record(value, '$');
  return {
    activities: arrayValue(input.activities, '$.activities').map((item, index) => parseJulesActivity(item, `$.activities[${index}]`)),
    nextPageToken: stringValue(input.nextPageToken, '$.nextPageToken', false),
  };
}

export function parseEmptyJulesResponse(value: unknown): void {
  if (value === undefined || value === null) return;
  const input = record(value, '$');
  if (Object.keys(input).length !== 0) throw new JulesContractError('$', 'expected an empty response');
}
