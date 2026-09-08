/**
 * Ripwire integration — deterministic codebase maps for AI context.
 *
 * Ripwire produces ranked, quality-annotated call graphs from a repository in
 * sub-second time without a daemon, index server, or API key. This module
 * wraps the Windows binary and exposes the specific verbs Orchestra uses:
 *
 *  --for="<task>"        → task-oriented ranked map (orientation + token savings)
 *  --situ                → changed-file blast radius (builder context)
 *  --quality-delta       → regressions introduced since baseSha (review feedback)
 *  --test-gate           → minimal test set to run (verification targeting)
 *  --pr-context=<ref>    → PR/diff cochange partners (audit context)
 *
 * Every call is time-boxed and degradable: typed probe outcomes let Orchestra
 * continue with its existing evidence chain while preserving diagnostics.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { probeRipwire, type ProbeResult } from './ripwire-probe.js';

const RIPWIRE_EXE = process.env.RIPWIRE_PATH || 'F:\\Ripwire\\ripwire-0.5.0\\ripwire-0.5.0\\build\\ripwire.exe';
const DEFAULT_MAX_TOKENS = 8_000;
const RIPWIRE_TIMEOUT_MS = 60_000;
export interface RipwireResult extends ProbeResult {
  estimatedTokens: number;
  command: string;
  baseline?: string;
}

/** Returns true if the ripwire binary is reachable on disk. */
export function isRipwireAvailable(): boolean {
  try {
    return existsSync(RIPWIRE_EXE);
  } catch {
    return false;
  }
}

/**
 * Run a ripwire command with the given flags. Callers receive a typed outcome
 * even when the executable is unavailable, cancelled, or times out.
 */
async function runRipwire(root: string, args: string[], timeoutMs = RIPWIRE_TIMEOUT_MS,
  signal?: AbortSignal, acceptedExitCodes: readonly number[] = [0]): Promise<ProbeResult> {
  return probeRipwire(root, args, { timeoutMs, signal, acceptedExitCodes });
}

function asResult(probe: ProbeResult, command: string): RipwireResult {
  // The raw report is persisted by ripwire-probe before this presentation trim.
  // Remove only the explanatory XML legend; rows, findings, and coverage remain verbatim.
  const output = stripRipwireLegendComments(probe.output) || `[Ripwire ${probe.status}: ${probe.stderr || 'No output'}]`;
  return { ...probe, output, estimatedTokens: estimateTokens(output), command };
}

function stripRipwireLegendComments(text: string): string {
  if (!text.includes('<!--')) return text.trim();
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf('<!--', cursor);
    if (start < 0) { parts.push(text.slice(cursor)); break; }
    const cdata = text.indexOf('<![CDATA[', cursor);
    if (cdata >= 0 && cdata < start) {
      const end = text.indexOf(']]>', cdata + 9);
      if (end < 0) { parts.push(text.slice(cursor)); break; }
      parts.push(text.slice(cursor, end + 3)); cursor = end + 3; continue;
    }
    parts.push(text.slice(cursor, start));
    const end = text.indexOf('-->', start + 4);
    if (end < 0) break;
    cursor = end + 3;
  }
  return parts.join('').trim();
}

export function ripwireEvidenceText(result: RipwireResult): string {
  return `[Ripwire status=${result.status}; baseline=${result.baseline || 'current tree'}; coverage=${result.coverage.state}]\n${result.output}`
    + (result.stderr ? `\nDiagnostics: ${result.stderr}` : '')
    + (result.coverage.omissions.length ? `\nUncovered: ${JSON.stringify(result.coverage.omissions)}` : '');
}

export async function runRipwireCoverage(root: string, signal?: AbortSignal) {
  const probe = await runRipwire(root, ['--index-coverage'], RIPWIRE_TIMEOUT_MS, signal);
  if (probe.status !== 'ok') return { probe, indexed: [] as string[], valid: false };
  try {
    const value: unknown = JSON.parse(probe.output);
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1
      || !('indexed' in value) || !Array.isArray(value.indexed) || !value.indexed.every(p => typeof p === 'string')) throw new Error('Invalid coverage schema');
    return { probe, indexed: value.indexed as string[], valid: true };
  } catch (error) { return { probe: { ...probe, status: 'failed' as const, stderr: String(error) }, indexed: [] as string[], valid: false }; }
}

async function selectedProbe(root: string, verb: string, files: readonly string[] | undefined, signal: AbortSignal | undefined, codes: number[]) {
  if (!files || files.length === 0) return runRipwire(root, [verb], RIPWIRE_TIMEOUT_MS, signal, codes);
  const coverage = await runRipwireCoverage(root, signal);
  const normalized = files.map(file => process.platform === 'win32' ? file.replaceAll('\\', '/').replace(/^\.\//, '') : file.replace(/^\.\//, ''));
  const omissions = normalized.filter(file => file.includes(',') || !coverage.indexed.includes(file))
    .map(path => ({ path, reason: path.includes(',') ? 'CSV-ambiguous selector' : coverage.valid ? 'not indexed' : 'index coverage unavailable' }));
  const selected = normalized.filter(file => !omissions.some(o => o.path === file));
  if (!selected.length) return { ...coverage.probe, status: 'partial' as const, output: 'No requested paths could be analyzed.', coverage: { state: 'partial' as const, omissions } };
  const result = await runRipwire(root, [`${verb}=${selected.map(file => join(root, file)).join(',')}`], RIPWIRE_TIMEOUT_MS, signal, codes);
  return { ...result, status: omissions.length && ['ok', 'findings'].includes(result.status) ? 'partial' as const : result.status,
    coverage: { state: omissions.length ? 'partial' as const : 'complete' as const, omissions } };
}

/**
 * Stage 2 / Stage 5: Task-oriented map.
 * `ripwire <root> --for="<task>" --token-budget=N`
 * Returns the compact XML context bundle and its probe metadata.
 */
export async function runRipwireFor(
  root: string,
  task: string,
  maxTokens = DEFAULT_MAX_TOKENS,
  signal?: AbortSignal,
): Promise<RipwireResult> {
  const probe = await runRipwire(
    root,
    [`--for=${task}`, `--token-budget=${maxTokens}`],
    RIPWIRE_TIMEOUT_MS,
    signal,
  );
  return asResult(probe, `ripwire ${root} --for="${task}" --token-budget=${maxTokens}`);
}

/**
 * Stage 5: Situational awareness — changed-file blast radius.
 * `ripwire <root> --situ`
 * Returns changed-file neighbours and tests to run, with coverage metadata.
 */
export async function runRipwireSitu(
  root: string,
  signal?: AbortSignal,
  files?: readonly string[],
): Promise<RipwireResult> {
  const args = ['--situ'];
  const probe = await selectedProbe(root, '--situ', files, signal, [0]);
  return asResult(probe, `ripwire ${root} ${args[0]}`);
}

/**
 * Stage 6 / Stage 7: Minimal test gate after a diff.
 * `ripwire <root> --test-gate`
 * Returns the ranked set of tests that must run for changed files.
 */
export async function runRipwireTestGate(
  root: string,
  signal?: AbortSignal,
  files?: readonly string[],
): Promise<RipwireResult> {
  const args = ['--test-gate'];
  const probe = await selectedProbe(root, '--test-gate', files, signal, [0, 4]);
  return asResult(probe, `ripwire ${root} ${args[0]}`);
}

/**
 * Stage 7: Quality delta — what the agent-written change made worse.
 * `ripwire <root> --quality-delta`
 * Returns regressions introduced in the working tree vs HEAD.
 */
export async function runRipwireQualityDelta(
  root: string,
  signal?: AbortSignal,
): Promise<RipwireResult> {
  const probe = await runRipwire(root, ['--quality-delta'], RIPWIRE_TIMEOUT_MS, signal, [0, 2]);
  return { ...asResult(probe, `ripwire ${root} --quality-delta`), baseline: 'HEAD to working tree' };
}

/**
 * Stage 7 Audit: PR / diff co-change partners.
 * `ripwire <root> --pr-context=<ref>`
 * Returns cochange partners and missing test files for the diff vs ref.
 */
export async function runRipwirePrContext(
  root: string,
  baseSha: string,
  signal?: AbortSignal,
): Promise<RipwireResult> {
  const output = await runRipwire(
    root,
    [`--pr-context=${baseSha}`, `--token-budget=${DEFAULT_MAX_TOKENS}`],
    RIPWIRE_TIMEOUT_MS,
    signal,
  );
  return asResult(output, `ripwire ${root} --pr-context=${baseSha}`);
}

/** Conservative token estimate (bytes / 4). */
function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}
