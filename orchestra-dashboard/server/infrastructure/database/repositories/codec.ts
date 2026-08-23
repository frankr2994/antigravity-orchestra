import { redactSecretsDeep } from '../../security/redaction.js';

export function parseJsonRecord(raw: unknown, label: string): Record<string, unknown> {
  if (typeof raw !== 'string') throw new TypeError(`${label} is not JSON text`);
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError(`${label} must contain a JSON object`);
  }
  return redactSecretsDeep(parsed as Record<string, unknown>);
}

export function encodeJsonRecord(value: Record<string, unknown>, label: string): string {
  const encoded = JSON.stringify(redactSecretsDeep(value));
  if (encoded.length > 1_000_000) throw new TypeError(`${label} exceeds the 1 MB persistence limit`);
  return encoded;
}

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} is invalid`);
  return value;
}

export function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
