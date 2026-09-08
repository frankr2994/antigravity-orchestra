export type RiderCircuitState = 'closed' | 'open' | 'half_open';

interface EndpointCircuit { failures: number[]; openedAt: number | null; probeInFlight: boolean; initialized: boolean; toolsListed: boolean }

export class RiderCircuitBreaker {
  private readonly endpoints = new Map<string, EndpointCircuit>();
  constructor(private readonly now: () => number = Date.now, private readonly failureWindowMs = 120_000, private readonly openMs = 600_000) {}

  state(endpoint: string): RiderCircuitState {
    const item = this.get(endpoint);
    if (item.openedAt === null) return 'closed';
    return this.now() - item.openedAt >= this.openMs ? 'half_open' : 'open';
  }

  permit(endpoint: string): boolean {
    const item = this.get(endpoint);
    const state = this.state(endpoint);
    if (state === 'closed') return true;
    if (state === 'open' || item.probeInFlight) return false;
    item.probeInFlight = true;
    item.initialized = false;
    item.toolsListed = false;
    return true;
  }

  recordInitialize(endpoint: string) { this.get(endpoint).initialized = true; }
  recordToolsListed(endpoint: string) {
    const item = this.get(endpoint);
    item.toolsListed = true;
    if (item.initialized) this.reset(endpoint);
  }
  recordSuccess(endpoint: string) {
    const item = this.get(endpoint);
    if (item.initialized && item.toolsListed) this.reset(endpoint);
  }
  recordFailure(endpoint: string): RiderCircuitState {
    const item = this.get(endpoint);
    const cutoff = this.now() - this.failureWindowMs;
    item.failures = item.failures.filter((time) => time >= cutoff);
    item.failures.push(this.now());
    item.probeInFlight = false;
    item.initialized = false;
    item.toolsListed = false;
    if (item.failures.length >= 2) item.openedAt = this.now();
    return this.state(endpoint);
  }
  reset(endpoint: string) { this.endpoints.set(endpoint, { failures: [], openedAt: null, probeInFlight: false, initialized: false, toolsListed: false }); }
  snapshot(endpoint: string) { const item = this.get(endpoint); return { state: this.state(endpoint), failures: item.failures.length, openedAt: item.openedAt }; }
  private get(endpoint: string) {
    let item = this.endpoints.get(endpoint);
    if (!item) { item = { failures: [], openedAt: null, probeInFlight: false, initialized: false, toolsListed: false }; this.endpoints.set(endpoint, item); }
    return item;
  }
}
