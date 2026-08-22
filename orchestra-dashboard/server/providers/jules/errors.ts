// ============================================================================
// Google Jules API Error Handling & Credential Redaction
// ============================================================================

export function redactSecrets(text: string): string {
  if (!text) return '';
  return text
    .replace(/([?&]key=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/(AIzaSy[A-Za-z0-9_-]+)/g, '[REDACTED_API_KEY]')
    .replace(/(ghp_[A-Za-z0-9_]+)/g, '[REDACTED_GH_TOKEN]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, '$1[REDACTED_TOKEN]');
}

export interface GoogleRpcStatus {
  code?: number;
  message?: string;
  details?: Array<Record<string, unknown>>;
}

export class JulesApiError extends Error {
  readonly status: number;
  readonly code?: number;
  readonly details?: Array<Record<string, unknown>>;
  readonly rawUrl: string;

  constructor(message: string, status: number, rawUrl: string, errorBody?: GoogleRpcStatus | unknown) {
    const sanitizedUrl = redactSecrets(rawUrl);
    const sanitizedMessage = redactSecrets(message);
    super(`Jules API Error (${status}) on ${sanitizedUrl}: ${sanitizedMessage}`);
    this.name = 'JulesApiError';
    this.status = status;
    this.rawUrl = sanitizedUrl;

    if (errorBody && typeof errorBody === 'object') {
      const body = errorBody as { error?: GoogleRpcStatus };
      const statusObj = body.error || (errorBody as GoogleRpcStatus);
      this.code = statusObj.code;
      this.details = statusObj.details;
    }
  }

  get isTransient(): boolean {
    return [408, 429, 500, 502, 503, 504].includes(this.status);
  }
}
