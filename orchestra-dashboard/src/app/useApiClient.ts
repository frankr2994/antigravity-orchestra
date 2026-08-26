import { useCallback, useRef, useState } from 'react';

export function useApiClient() {
  const [token, setTokenState] = useState('');
  const tokenRef = useRef('');
  const setToken = useCallback((value: string) => { tokenRef.current = value; setTokenState(value); }, []);

  const authenticatedFetch = useCallback(async (path: string, options: RequestInit = {}, overrideToken?: string) => {
    const request = (activeToken: string) => fetch(path, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(activeToken ? { 'X-Orchestra-Token': activeToken } : {}), ...options.headers },
    });
    let response = await request(tokenRef.current || overrideToken || '');
    if (response.status === 403) {
      const bootstrapResponse = await fetch('/api/bootstrap', { cache: 'no-store' });
      if (bootstrapResponse.ok) {
        const bootstrap: unknown = await bootstrapResponse.json();
        const freshToken = bootstrap && typeof bootstrap === 'object' && typeof (bootstrap as Record<string, unknown>).token === 'string'
          ? String((bootstrap as Record<string, unknown>).token)
          : '';
        if (freshToken) { setToken(freshToken); response = await request(freshToken); }
      }
    }
    return response;
  }, [setToken]);

  const api = useCallback(async <T,>(path: string, options: RequestInit = {}, overrideToken?: string): Promise<T> => {
    const response = await authenticatedFetch(path, options, overrideToken);
    const body = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      const value = body && typeof body === 'object' ? body as Record<string, unknown> : {};
      const detail = value.resolution || value.nextAction;
      const code = value.code ? ` [${String(value.code)}]` : '';
      throw new Error(`${value.error || `Request failed (${response.status})`}${detail ? ` Next step: ${String(detail)}` : ''}${code}`);
    }
    return body as T;
  }, [authenticatedFetch]);

  return { token, setToken, api };
}
