import { JulesApiError, redactSecrets } from './errors.js';
import type {
  JulesCreateSessionRequest,
  JulesListActivitiesResponse,
  JulesListSessionsResponse,
  JulesListSourcesResponse,
  JulesSession,
  JulesSource,
} from './types.js';
import {
  JulesContractError,
  parseEmptyJulesResponse,
  parseJulesListActivitiesResponse,
  parseJulesListSessionsResponse,
  parseJulesListSourcesResponse,
  parseJulesSession,
  parseJulesSource,
} from './validation.js';
import { recordJulesRequest } from './metrics.js';

// ============================================================================
// Google Jules REST API Client (Authoritative Alpha)
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
  #apiKey: string;
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
    this.#apiKey = options.apiKey.trim();
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
    method: 'GET' | 'POST' | 'DELETE',
    body: unknown,
    parse: (value: unknown) => T,
    signal?: AbortSignal
  ): Promise<T> {
    const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    const url = `${this.baseUrl}${cleanEndpoint}`;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const startedAt = Date.now();
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
            'X-Goog-Api-Key': this.#apiKey,
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
        recordJulesRequest(cleanEndpoint, response.status, Date.now() - startedAt);

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
          if (method === 'GET' && apiError.isTransient && attempt < this.maxRetries) {
            const backoff = this.calculateBackoff(attempt);
            await this.sleep(backoff);
            lastError = apiError;
            continue;
          }

          throw apiError;
        }

        // 204 No Content
        if (response.status === 204) {
          return parse(undefined);
        }

        let data: unknown;
        if (typeof response.text === 'function') {
          const raw = await response.text();
          if (!raw.trim()) data = undefined;
          else {
            try {
              data = JSON.parse(raw);
            } catch {
              throw new JulesContractError('$', 'response body is not valid JSON');
            }
          }
        } else {
          data = await response.json();
        }
        return parse(data);
      } catch (err: unknown) {
        clearTimeout(timeoutId);
        if (signal) signal.removeEventListener('abort', abortHandler);

        if (!(err instanceof JulesApiError) && !(err instanceof JulesContractError)) recordJulesRequest(cleanEndpoint, null, Date.now() - startedAt);
        if (err instanceof JulesApiError) {
          throw err;
        }
        if (err instanceof JulesContractError) {
          throw err;
        }

        const rawMessage = err instanceof Error ? err.message : String(err);
        const safeMessage = redactSecrets(rawMessage);
        const error = new Error(`Jules request failed: ${safeMessage}`);
        lastError = error;

        // Network failures retry
        if (method === 'GET' && attempt < this.maxRetries && !signal?.aborted) {
          const backoff = this.calculateBackoff(attempt);
          await this.sleep(backoff);
          continue;
        }

        throw error;
      }
    }

    throw lastError || new Error('Request failed after retries.');
  }

  // 1. List Sources (with pagination)
  async listSources(pageToken?: string, pageSize?: number, signal?: AbortSignal): Promise<JulesListSourcesResponse> {
    const params = new URLSearchParams();
    if (pageToken) params.set('pageToken', pageToken);
    if (pageSize) params.set('pageSize', String(pageSize));
    const query = params.toString() ? `?${params.toString()}` : '';
    return this.request<JulesListSourcesResponse>(`/sources${query}`, 'GET', undefined, parseJulesListSourcesResponse, signal);
  }

  // 2. Get Source
  async getSource(name: string, signal?: AbortSignal): Promise<JulesSource> {
    const resourceName = name.startsWith('sources/') ? name : `sources/${name}`;
    return this.request<JulesSource>(`/${resourceName}`, 'GET', undefined, parseJulesSource, signal);
  }

  // 3. Create Session
  async createSession(request: JulesCreateSessionRequest, signal?: AbortSignal): Promise<JulesSession> {
    // Only send automationMode if explicitly specified and valid
    const cleanRequest: JulesCreateSessionRequest = {
      prompt: request.prompt,
      sourceContext: request.sourceContext,
      title: request.title,
      requirePlanApproval: request.requirePlanApproval,
    };
    if (request.automationMode === 'AUTO_CREATE_PR') {
      cleanRequest.automationMode = 'AUTO_CREATE_PR';
    }
    return this.request<JulesSession>('/sessions', 'POST', cleanRequest, parseJulesSession, signal);
  }

  // 4. List Sessions (with pagination)
  async listSessions(pageSize?: number, pageToken?: string, signal?: AbortSignal): Promise<JulesListSessionsResponse> {
    const params = new URLSearchParams();
    if (pageToken) params.set('pageToken', pageToken);
    if (pageSize) params.set('pageSize', String(pageSize));
    const query = params.toString() ? `?${params.toString()}` : '';
    return this.request<JulesListSessionsResponse>(`/sessions${query}`, 'GET', undefined, parseJulesListSessionsResponse, signal);
  }

  // 5. Get Session
  async getSession(name: string, signal?: AbortSignal): Promise<JulesSession> {
    const resourceName = name.startsWith('sessions/') ? name : `sessions/${name}`;
    return this.request<JulesSession>(`/${resourceName}`, 'GET', undefined, parseJulesSession, signal);
  }

  // 6. Delete Session
  async deleteSession(name: string, signal?: AbortSignal): Promise<void> {
    const resourceName = name.startsWith('sessions/') ? name : `sessions/${name}`;
    await this.request<void>(`/${resourceName}`, 'DELETE', undefined, parseEmptyJulesResponse, signal);
  }

  // 7. List Activities (with pagination)
  async listActivities(
    sessionName: string,
    pageSize?: number,
    pageToken?: string,
    signal?: AbortSignal,
    createTime?: string,
  ): Promise<JulesListActivitiesResponse> {
    const resourceName = sessionName.startsWith('sessions/') ? sessionName : `sessions/${sessionName}`;
    const params = new URLSearchParams();
    if (pageToken) params.set('pageToken', pageToken);
    if (pageSize) params.set('pageSize', String(pageSize));
    if (createTime) params.set('createTime', createTime);
    const query = params.toString() ? `?${params.toString()}` : '';
    return this.request<JulesListActivitiesResponse>(`/${resourceName}/activities${query}`, 'GET', undefined, parseJulesListActivitiesResponse, signal);
  }

  // 8. Approve Plan
  async approvePlan(sessionName: string, signal?: AbortSignal): Promise<void> {
    const resourceName = sessionName.startsWith('sessions/') ? sessionName : `sessions/${sessionName}`;
    await this.request<void>(`/${resourceName}:approvePlan`, 'POST', {}, parseEmptyJulesResponse, signal);
  }

  // 9. Send Message (authoritative endpoint)
  async sendMessage(sessionName: string, prompt: string, signal?: AbortSignal): Promise<void> {
    const resourceName = sessionName.startsWith('sessions/') ? sessionName : `sessions/${sessionName}`;
    await this.request<void>(`/${resourceName}:sendMessage`, 'POST', { prompt }, parseEmptyJulesResponse, signal);
  }
}
