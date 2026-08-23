// ============================================================================
// Centralized Security: Secret & Credential Redaction Boundary
// ============================================================================

export function redactSecrets(text: string): string {
  if (!text) return '';
  return text
    .replace(/([?&](?:api[_-]?key|key|token|password|secret)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/((?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED_TOKEN]')
    .replace(/\b((?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|password|secret|authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(AIzaSy[A-Za-z0-9_-]+)/g, '[REDACTED_API_KEY]')
    .replace(/(gh[pousr]_[A-Za-z0-9_]+)/g, '[REDACTED_GH_TOKEN]')
    .replace(/(sk-(?:proj-)?[A-Za-z0-9_-]+)/g, '[REDACTED_KEY]')
    .replace(/(https?:\/\/[^/:]+):([^@\s]+)@/gi, '$1:[REDACTED_PASSWORD]@');
}

export function redactSecretsDeep<T>(value: T): T {
  const seen = new WeakSet<object>();
  const secretKey = /^(?:api[_-]?key|apikey|key|token|access[_-]?token|refresh[_-]?token|password|passwd|secret|authorization|cookie|set-cookie)$/i;

  function visit(input: unknown, depth: number): unknown {
    if (input === null || input === undefined) return input;
    if (typeof input === 'string') return redactSecrets(input);
    if (typeof input !== 'object') return input;
    if (depth > 20) return '[REDACTED_DEPTH_LIMIT]';
    if (seen.has(input)) return '[CIRCULAR]';
    seen.add(input);
    if (input instanceof Error) {
      return {
        name: redactSecrets(input.name),
        message: redactSecrets(input.message),
        stack: input.stack ? redactSecrets(input.stack) : undefined,
        cause: visit(input.cause, depth + 1),
      };
    }
    if (input instanceof Date) return input.toISOString();
    if (Array.isArray(input)) return input.map((item) => visit(item, depth + 1));
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(input as Record<string, unknown>)) {
      result[key] = secretKey.test(key) ? '[REDACTED]' : visit(nested, depth + 1);
    }
    return result;
  }

  return visit(value, 0) as T;
}
