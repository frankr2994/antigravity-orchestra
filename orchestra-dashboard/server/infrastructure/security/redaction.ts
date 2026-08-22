// ============================================================================
// Centralized Security: Secret & Credential Redaction Boundary
// ============================================================================

export function redactSecrets(text: string): string {
  if (!text) return '';
  return text
    .replace(/([?&]key=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/(AIzaSy[A-Za-z0-9_-]+)/g, '[REDACTED_API_KEY]')
    .replace(/(ghp_[A-Za-z0-9_]+)/g, '[REDACTED_GH_TOKEN]')
    .replace(/(sk-proj-[A-Za-z0-9_-]+)/g, '[REDACTED_KEY]')
    .replace(/(https?:\/\/[^/:]+):([^@\s]+)@/gi, '$1:[REDACTED_PASSWORD]@')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, '$1[REDACTED_TOKEN]');
}

export function redactSecretsDeep<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map(redactSecretsDeep) as unknown as T;
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = redactSecretsDeep(v);
    }
    return result as unknown as T;
  }
  return value;
}
