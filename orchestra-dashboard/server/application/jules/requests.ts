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
export interface JulesDispatchCommand {
  prompt: string;
  sessionId?: string;
  requirePlanApproval: boolean;
  autoPr: boolean;
  idempotencyKey: string;
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
export function parseMessageRequest(value: unknown): string {
  const input = record(value);
  const prompt = input.prompt ?? input.message;
  return boundedString(prompt, 'prompt', 100_000)!;
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
