import { JulesApiError, redactSecrets } from './errors.js';
import type {
  JulesActivity,
  JulesCreateSessionRequest,
  JulesListActivitiesResponse,
  JulesListSessionsResponse,
  JulesListSourcesResponse,
  JulesSession,
  JulesSource,
} from './types.js';

// ============================================================================
// Google Jules REST API Client (Alpha)
// ============================================================================

export interface JulesClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  fetchFn?: typeof fetch;
}

export class JulesApiClient {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
  private readonly fetch: typeof fetch;

  constructor(options: JulesClientOptions) {
    if (!options.apiKey || !options.apiKey.trim()) {
      throw new Error('Jules API key is required to instantiate JulesApiClient.');
    }
    this.apiKey = options.apiKey.trim();
    this.baseUrl = (options.baseUrl || 'https://jules.googleapis.com/v1alpha').replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.initialBackoffMs = options.initialBackoffMs ?? 500;
    this.maxBackoffMs = options.maxBackoffMs ?? 8000;
    this.fetch = options.fetchFn ?? globalThis.fetch;
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private calculateBackoff(attempt: number): number {
    const base = Math.min(this.maxBackoffMs, this.initialBackoffMs * 2 ** attempt);
    const jitter = Math.random() * (base * 0.2);
    return base + jitter;
  }

  private async request<T>(
    endpoint: string,
    method: 'GET' | 'POST' = 'GET',
    body?: unknown,
    signal?: AbortSignal
  ): Promise<T> {
    const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    const url = `${this.baseUrl}${cleanEndpoint}`;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(new Error('Request timed out')), this.timeoutMs);

      // Merge caller signal if provided
      const abortHandler = () => controller.abort();
      if (signal) {
        signal.addEventListener('abort', abortHandler, { once: true });
      }

      try {
        const response = await this.fetch(url, {
          method,
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': this.apiKey,
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        if (signal) signal.removeEventListener('abort', abortHandler);

        if (!response.ok) {
          let errorJson: unknown = null;
          let errorMessage = `HTTP ${response.status} ${response.statusText}`;
          try {
            errorJson = await response.json();
            if (errorJson && typeof errorJson === 'object') {
              const obj = errorJson as { error?: { message?: string } };
              if (obj.error?.message) {
                errorMessage = obj.error.message;
              }
            }
          } catch {
            /* ignore non-json response body */
          }

          const apiError = new JulesApiError(errorMessage, response.status, url, errorJson);

          // Retry on transient status codes
          if (apiError.isTransient && attempt < this.maxRetries) {
            const backoff = this.calculateBackoff(attempt);
            await this.sleep(backoff);
            lastError = apiError;
            continue;
          }

          throw apiError;
        }

        // 204 No Content
        if (response.status === 204) {
          return undefined as unknown as T;
        }

        const data = (await response.json()) as T;
        return data;
      } catch (err: unknown) {
        clearTimeout(timeoutId);
        if (signal) signal.removeEventListener('abort', abortHandler);

        if (err instanceof JulesApiError) {
          throw err;
        }

        const rawMessage = err instanceof Error ? err.message : String(err);
        const safeMessage = redactSecrets(rawMessage);
        const error = new Error(`Jules request failed: ${safeMessage}`);
        lastError = error;

        // Network failures retry
        if (attempt < this.maxRetries && !signal?.aborted) {
          const backoff = this.calculateBackoff(attempt);
          await this.sleep(backoff);
          continue;
        }

        throw error;
      }
    }

    throw lastError || new Error('Request failed after retries.');
  }

  // 1. List Sources
  async listSources(pageToken?: string, pageSize?: number, signal?: AbortSignal): Promise<JulesSource[]> {
    const params = new URLSearchParams();
    if (pageToken) params.set('pageToken', pageToken);
    if (pageSize) params.set('pageSize', String(pageSize));
    const query = params.toString() ? `?${params.toString()}` : '';
    const res = await this.request<JulesListSourcesResponse>(`/sources${query}`, 'GET', undefined, signal);
    return res.sources || [];
  }

  // 2. Create Session
  async createSession(request: JulesCreateSessionRequest, signal?: AbortSignal): Promise<JulesSession> {
    return this.request<JulesSession>('/sessions', 'POST', request, signal);
  }

  // 3. List Sessions
  async listSessions(pageSize?: number, pageToken?: string, signal?: AbortSignal): Promise<JulesListSessionsResponse> {
    const params = new URLSearchParams();
    if (pageToken) params.set('pageToken', pageToken);
    if (pageSize) params.set('pageSize', String(pageSize));
    const query = params.toString() ? `?${params.toString()}` : '';
    return this.request<JulesListSessionsResponse>(`/sessions${query}`, 'GET', undefined, signal);
  }

  // 4. Get Session
  async getSession(name: string, signal?: AbortSignal): Promise<JulesSession> {
    const resourceName = name.startsWith('sessions/') ? name : `sessions/${name}`;
    return this.request<JulesSession>(`/${resourceName}`, 'GET', undefined, signal);
  }

  // 5. List Activities
  async listActivities(
    sessionName: string,
    pageSize?: number,
    pageToken?: string,
    signal?: AbortSignal
  ): Promise<JulesActivity[]> {
    const resourceName = sessionName.startsWith('sessions/') ? sessionName : `sessions/${sessionName}`;
    const params = new URLSearchParams();
    if (pageToken) params.set('pageToken', pageToken);
    if (pageSize) params.set('pageSize', String(pageSize));
    const query = params.toString() ? `?${params.toString()}` : '';
    const res = await this.request<JulesListActivitiesResponse>(`/${resourceName}/activities${query}`, 'GET', undefined, signal);
    return res.activities || [];
  }

  // 6. Approve Plan
  async approvePlan(sessionName: string, signal?: AbortSignal): Promise<void> {
    const resourceName = sessionName.startsWith('sessions/') ? sessionName : `sessions/${sessionName}`;
    await this.request<void>(`/${resourceName}:approvePlan`, 'POST', {}, signal);
  }

  // 7. Send Feedback
  async sendFeedback(sessionName: string, message: string, signal?: AbortSignal): Promise<void> {
    const resourceName = sessionName.startsWith('sessions/') ? sessionName : `sessions/${sessionName}`;
    await this.request<void>(`/${resourceName}:sendFeedback`, 'POST', { message }, signal);
  }

  // 8. Pause
  async pause(sessionName: string, signal?: AbortSignal): Promise<void> {
    const resourceName = sessionName.startsWith('sessions/') ? sessionName : `sessions/${sessionName}`;
    await this.request<void>(`/${resourceName}:pause`, 'POST', {}, signal);
  }

  // 9. Resume
  async resume(sessionName: string, signal?: AbortSignal): Promise<void> {
    const resourceName = sessionName.startsWith('sessions/') ? sessionName : `sessions/${sessionName}`;
    await this.request<void>(`/${resourceName}:resume`, 'POST', {}, signal);
  }
}
