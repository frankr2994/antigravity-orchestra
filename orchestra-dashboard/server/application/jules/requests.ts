import { ApplicationError } from '../errors.js';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApplicationError('INVALID_REQUEST', 'Request body must be a JSON object.');
  }
  return value as Record<string, unknown>;
}
function boundedString(value: unknown, field: string, max: number, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new ApplicationError('INVALID_REQUEST', `${field} must be a non-empty string.`);
  const result = value.trim();
  if (result.length > max) throw new ApplicationError('INVALID_REQUEST', `${field} exceeds ${max} characters.`);
  return result;
}
function exactBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new ApplicationError('INVALID_REQUEST', `${field} must be a boolean.`);
  return value;
}

export function parseCredentialSaveRequest(value: unknown): { apiKey: string; validate: boolean } {
  const input = record(value);
  return { apiKey: boundedString(input.apiKey, 'apiKey', 4096)!, validate: exactBoolean(input.validate, 'validate', true) };
}
export function parseCredentialValidationRequest(value: unknown): { apiKey?: string } {
  if (value === undefined || value === null) return {};
  const input = record(value);
  return { apiKey: boundedString(input.apiKey, 'apiKey', 4096, false) };
}

export function parseJulesEnabledRequest(value: unknown): { enabled: boolean } {
  const input = record(value);
  if (!Object.hasOwn(input, 'enabled')) throw new ApplicationError('INVALID_REQUEST', 'enabled is required.');
  return { enabled: exactBoolean(input.enabled, 'enabled', false) };
}
export interface JulesDispatchCommand {
  prompt: string;
  sessionId?: string;
  requirePlanApproval: boolean;
  autoPr: boolean;
  idempotencyKey: string;
}
export interface JulesBatchCommand {
  idempotencyKey: string;
  maxConcurrency?: number;
  items: Array<{ prompt: string; dependsOn: number[] }>;
}
export function parseBatchDispatchRequest(value: unknown, idempotencyHeader?: string): JulesBatchCommand {
  const input = record(value);
  if (!Array.isArray(input.items) || input.items.length < 2 || input.items.length > 50) {
    throw new ApplicationError('INVALID_REQUEST', 'items must contain between 2 and 50 cloud work items.');
  }
  const itemCount = input.items.length;
  let maxConcurrency: number | undefined;
  if (input.maxConcurrency !== undefined) {
    if (!Number.isSafeInteger(input.maxConcurrency) || Number(input.maxConcurrency) < 1 || Number(input.maxConcurrency) > 32) {
      throw new ApplicationError('INVALID_REQUEST', 'maxConcurrency must be an integer from 1 to 32.');
    }
    maxConcurrency = Number(input.maxConcurrency);
  }
  const items = input.items.map((raw, ordinal) => {
    const item = record(raw); const dependencies = item.dependsOn ?? [];
    if (!Array.isArray(dependencies) || !dependencies.every((entry) => Number.isSafeInteger(entry) && Number(entry) >= 0 && Number(entry) < itemCount && Number(entry) !== ordinal)) {
      throw new ApplicationError('INVALID_REQUEST', `items[${ordinal}].dependsOn contains an invalid node index.`);
    }
    const dependsOn = [...new Set(dependencies.map(Number))];
    return { prompt: boundedString(item.prompt, `items[${ordinal}].prompt`, 100_000)!, dependsOn };
  });
  const visiting = new Set<number>(); const visited = new Set<number>();
  const visit = (node: number) => {
    if (visiting.has(node)) throw new ApplicationError('INVALID_REQUEST', 'Workflow dependencies must form an acyclic graph.');
    if (visited.has(node)) return; visiting.add(node);
    for (const dependency of items[node].dependsOn) visit(dependency);
    visiting.delete(node); visited.add(node);
  };
  items.forEach((_, index) => visit(index));
  return { idempotencyKey: idempotency(input, idempotencyHeader), maxConcurrency, items };
}
export function parseRoutedExecutionRequest(value: unknown, idempotencyHeader?: string) {
  const input = record(value); const target = input.target ?? 'auto';
  if (!['auto', 'local', 'cloud'].includes(String(target))) throw new ApplicationError('INVALID_REQUEST', 'target must be auto, local, or cloud.');
  return { prompt: boundedString(input.prompt, 'prompt', 100_000)!, sessionId: boundedString(input.sessionId, 'sessionId', 200)!,
    idempotencyKey: idempotency(input, idempotencyHeader), target: target as 'auto' | 'local' | 'cloud' };
}
export function parseDispatchRequest(value: unknown, idempotencyHeader?: string): JulesDispatchCommand {
  const input = record(value);
  const suppliedKey = boundedString(input.idempotencyKey, 'idempotencyKey', 200, false) ?? idempotencyHeader?.trim();
  if (!suppliedKey) throw new ApplicationError('IDEMPOTENCY_KEY_REQUIRED', 'An idempotency key is required.', 400);
  return {
    prompt: boundedString(input.prompt, 'prompt', 100_000)!,
    sessionId: boundedString(input.sessionId, 'sessionId', 200, false),
    requirePlanApproval: exactBoolean(input.requirePlanApproval, 'requirePlanApproval', true),
    autoPr: exactBoolean(input.autoPr, 'autoPr', true),
    idempotencyKey: suppliedKey,
  };
}
function idempotency(input: Record<string, unknown>, header?: string): string {
  const key = boundedString(input.idempotencyKey, 'idempotencyKey', 200, false) ?? header?.trim();
  if (!key) throw new ApplicationError('IDEMPOTENCY_KEY_REQUIRED', 'An idempotency key is required.', 400);
  return key;
}
export function parseInteractionRequest(value: unknown, header?: string): { idempotencyKey: string } {
  const input = value === undefined ? {} : record(value);
  return { idempotencyKey: idempotency(input, header) };
}
export function parseMessageRequest(value: unknown, header?: string): { prompt: string; idempotencyKey: string } {
  const input = record(value);
  const prompt = input.prompt ?? input.message;
  return { prompt: boundedString(prompt, 'prompt', 100_000)!, idempotencyKey: idempotency(input, header) };
}
export function parseActivityPage(query: Record<string, unknown>): { pageSize?: number; pageToken?: string } {
  let pageSize: number | undefined;
  if (query.pageSize !== undefined) {
    const text = String(query.pageSize);
    if (!/^\d+$/.test(text)) throw new ApplicationError('INVALID_PAGE_SIZE', 'pageSize must be an integer from 1 to 100.');
    pageSize = Number(text);
    if (pageSize < 1 || pageSize > 100) throw new ApplicationError('INVALID_PAGE_SIZE', 'pageSize must be an integer from 1 to 100.');
  }
  const pageToken = boundedString(query.pageToken, 'pageToken', 4096, false);
  return { pageSize, pageToken };
}
