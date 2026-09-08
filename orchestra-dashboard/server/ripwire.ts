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
 * Every call is time-boxed and degradable: a failed or timed-out probe returns
 * null and Orchestra continues with its existing evidence chain unchanged.
 */

import { existsSync } from 'node:fs';
import { runProcess } from './process.js';

const RIPWIRE_EXE =
  process.env.RIPWIRE_PATH ||
  'F:\\Ripwire\\ripwire-0.5.0\\ripwire-0.5.0\\build\\ripwire.exe';

/** Maximum token budget we allow ripwire to produce per call (~8K tokens ≈ 32K bytes). */
const DEFAULT_MAX_TOKENS = 8_000;
/** Execution time ceiling for any ripwire call. */
const RIPWIRE_TIMEOUT_MS = 30_000;

export interface RipwireResult {
  output: string;
  estimatedTokens: number;
  command: string;
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
 * Run a ripwire command with the given flags and return its stdout, or null on
 * any error. Calls are fire-and-forget from the pipeline's perspective: a null
 * result is handled by the caller falling back to its ordinary evidence.
 */
async function runRipwire(
  root: string,
  args: string[],
  timeoutMs = RIPWIRE_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const result = await runProcess(
      RIPWIRE_EXE,
      [root, ...args, '--no-ignore', '--cache=' + root + '/.ripwire.lean.ripwirecache'],
      { cwd: root, timeoutMs, idleTimeoutMs: timeoutMs, signal, maxOutputChars: 200_000 },
    );
    if (result.code !== 0) return null;
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Stage 2 / Stage 5: Task-oriented map.
 * `ripwire <root> --for="<task>" --max-tokens=N`
 * Returns the compact XML context bundle, or null if unavailable.
 */
export async function runRipwireFor(
  root: string,
  task: string,
  maxTokens = DEFAULT_MAX_TOKENS,
  signal?: AbortSignal,
): Promise<RipwireResult | null> {
  const output = await runRipwire(
    root,
    [`--for=${task}`, `--max-tokens=${maxTokens}`],
    RIPWIRE_TIMEOUT_MS,
    signal,
  );
  if (!output) return null;
  return {
    output,
    estimatedTokens: estimateTokens(output),
    command: `ripwire ${root} --for="${task}" --max-tokens=${maxTokens}`,
  };
}

/**
 * Stage 5: Situational awareness — changed-file blast radius.
 * `ripwire <root> --situ`
 * Returns changed-file neighbours and tests to run, or null.
 */
export async function runRipwireSitu(
  root: string,
  signal?: AbortSignal,
): Promise<RipwireResult | null> {
  const output = await runRipwire(root, ['--situ'], RIPWIRE_TIMEOUT_MS, signal);
  if (!output) return null;
  return {
    output,
    estimatedTokens: estimateTokens(output),
    command: `ripwire ${root} --situ`,
  };
}

/**
 * Stage 6 / Stage 7: Minimal test gate after a diff.
 * `ripwire <root> --test-gate`
 * Returns the ranked set of tests that must run for changed files, or null.
 */
export async function runRipwireTestGate(
  root: string,
  signal?: AbortSignal,
): Promise<RipwireResult | null> {
  const output = await runRipwire(root, ['--test-gate'], RIPWIRE_TIMEOUT_MS, signal);
  if (!output) return null;
  return {
    output,
    estimatedTokens: estimateTokens(output),
    command: `ripwire ${root} --test-gate`,
  };
}

/**
 * Stage 7: Quality delta — what the agent-written change made worse.
 * `ripwire <root> --quality-delta`
 * Returns regressions introduced in the working tree vs HEAD, or null.
 */
export async function runRipwireQualityDelta(
  root: string,
  signal?: AbortSignal,
): Promise<RipwireResult | null> {
  const output = await runRipwire(root, ['--quality-delta'], RIPWIRE_TIMEOUT_MS, signal);
  if (!output) return null;
  return {
    output,
    estimatedTokens: estimateTokens(output),
    command: `ripwire ${root} --quality-delta`,
  };
}

/**
 * Stage 7 Audit: PR / diff co-change partners.
 * `ripwire <root> --pr-context=<ref>`
 * Returns cochange partners and missing test files for the diff vs ref, or null.
 */
export async function runRipwirePrContext(
  root: string,
  baseSha: string,
  signal?: AbortSignal,
): Promise<RipwireResult | null> {
  const output = await runRipwire(
    root,
    [`--pr-context=${baseSha}`, `--max-tokens=${DEFAULT_MAX_TOKENS}`],
    RIPWIRE_TIMEOUT_MS,
    signal,
  );
  if (!output) return null;
  return {
    output,
    estimatedTokens: estimateTokens(output),
    command: `ripwire ${root} --pr-context=${baseSha}`,
  };
}

/** Conservative token estimate (bytes / 4). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
