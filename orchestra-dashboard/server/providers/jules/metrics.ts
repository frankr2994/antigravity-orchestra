interface Metric { requests: number; failures: number; rateLimited: number; totalLatencyMs: number; lastStatus: number | null; }
const metrics = new Map<string, Metric>();
function operation(endpoint: string): string {
  const path = endpoint.split('?')[0].split('/').filter(Boolean);
  if (path[0] === 'sessions' && path.length > 1) return path.at(-1)?.includes(':') ? `sessions:${path.at(-1)!.split(':').at(-1)}` : path.at(-1) === 'activities' ? 'sessions:activities' : 'sessions:get';
  return path[0] || 'root';
}
export function recordJulesRequest(endpoint: string, status: number | null, latencyMs: number): void {
  const key = operation(endpoint); const current = metrics.get(key) ?? { requests: 0, failures: 0, rateLimited: 0, totalLatencyMs: 0, lastStatus: null };
  current.requests += 1; current.totalLatencyMs += Math.max(0, latencyMs); current.lastStatus = status;
  if (status === null || status >= 400) current.failures += 1; if (status === 429) current.rateLimited += 1; metrics.set(key, current);
}
export function snapshotJulesMetrics() {
  return [...metrics.entries()].map(([name, value]) => ({ name, requests: value.requests, failures: value.failures,
    rateLimited: value.rateLimited, averageLatencyMs: Math.round(value.totalLatencyMs / value.requests), lastStatus: value.lastStatus }));
}
