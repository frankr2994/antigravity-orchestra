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

import { existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runProcess } from './process.js';

const RIPWIRE_EXE =
  process.env.RIPWIRE_PATH ||
  'F:\\Ripwire\\ripwire-0.5.0\\ripwire-0.5.0\\build\\ripwire.exe';

/** Maximum token budget we allow ripwire to produce per call (~8K tokens ≈ 32K bytes). */
const DEFAULT_MAX_TOKENS = 8_000;
/** Execution time ceiling for any ripwire call. */
const RIPWIRE_TIMEOUT_MS = 60_000;

type RipwireCacheFamily = 'lean' | 'rich';

interface RipwireProbe {
  output: string;
  exitCode: number;
  stderr: string;
}

export interface RipwireResult {
  output: string;
  estimatedTokens: number;
  command: string;
  exitCode: number;
  status: 'ok' | 'findings';
  stderr?: string;
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
  acceptedExitCodes: readonly number[] = [0],
): Promise<RipwireProbe | null> {
  try {
    const commandArgs = [root, ...args];
    const cache = ripwireCachePath(root, ripwireCacheFamily(args));
    if (cache) commandArgs.push(`--cache=${cache}`);
    const result = await runProcess(
      RIPWIRE_EXE,
      commandArgs,
      { cwd: root, timeoutMs, idleTimeoutMs: timeoutMs, signal, maxOutputChars: 200_000 },
    );
    const output = result.stdout.trim();
    if (!acceptedExitCodes.includes(result.code) || !output) return null;
    return { output, exitCode: result.code, stderr: result.stderr.trim() };
  } catch {
    return null;
  }
}

function ripwireCacheFamily(args: readonly string[]): RipwireCacheFamily {
  return args.some((arg) => /^(?:--for=|--pr-context=|--metrics(?:=|$)|--uses(?:=|$)|--exemplar(?:=|$))/.test(arg))
    ? 'rich'
    : 'lean';
}

/**
 * Keep cache blobs out of the target repository and never share a lean parser
 * cache with a rich `--for`/`--pr-context` parse. The root hash makes a single
 * configurable cache directory safe for multiple projects.
 */
function ripwireCachePath(root: string, family: RipwireCacheFamily): string | null {
  const rootKey = createHash('sha256').update(root).digest('hex').slice(0, 16);
  const parent = process.env.RIPWIRE_CACHE_DIR?.trim() || join(tmpdir(), 'orchestra-ripwire-cache');
  const directory = join(parent, rootKey);
  try {
    mkdirSync(directory, { recursive: true });
    return join(directory, `ripwire.${family}.ripwirecache`);
  } catch {
    return null;
  }
}

function asResult(probe: RipwireProbe, command: string): RipwireResult {
  return {
    output: probe.output,
    estimatedTokens: estimateTokens(probe.output),
    command,
    exitCode: probe.exitCode,
    status: probe.exitCode === 0 ? 'ok' : 'findings',
    ...(probe.stderr ? { stderr: probe.stderr } : {}),
  };
}

function changedFileSelector(files?: readonly string[]): string | null {
  const selected = files?.map((file) => file.trim().replaceAll('\\', '/')).filter(Boolean) || [];
  return selected.length ? selected.join(',') : null;
}

/**
 * Stage 2 / Stage 5: Task-oriented map.
 * `ripwire <root> --for="<task>" --token-budget=N`
 * Returns the compact XML context bundle, or null if unavailable.
 */
export async function runRipwireFor(
  root: string,
  task: string,
  maxTokens = DEFAULT_MAX_TOKENS,
  signal?: AbortSignal,
): Promise<RipwireResult | null> {
  const probe = await runRipwire(
    root,
    [`--for=${task}`, `--token-budget=${maxTokens}`],
    RIPWIRE_TIMEOUT_MS,
    signal,
  );
  return probe ? asResult(probe, `ripwire ${root} --for="${task}" --token-budget=${maxTokens}`) : null;
}

/**
 * Stage 5: Situational awareness — changed-file blast radius.
 * `ripwire <root> --situ`
 * Returns changed-file neighbours and tests to run, or null.
 */
export async function runRipwireSitu(
  root: string,
  signal?: AbortSignal,
  files?: readonly string[],
): Promise<RipwireResult | null> {
  const selector = changedFileSelector(files);
  const args = [selector ? `--situ=${selector}` : '--situ'];
  const probe = await runRipwire(root, args, RIPWIRE_TIMEOUT_MS, signal);
  return probe ? asResult(probe, `ripwire ${root} ${args[0]}`) : null;
}

/**
 * Stage 6 / Stage 7: Minimal test gate after a diff.
 * `ripwire <root> --test-gate`
 * Returns the ranked set of tests that must run for changed files, or null.
 */
export async function runRipwireTestGate(
  root: string,
  signal?: AbortSignal,
  files?: readonly string[],
): Promise<RipwireResult | null> {
  const selector = changedFileSelector(files);
  const args = [selector ? `--test-gate=${selector}` : '--test-gate'];
  const probe = await runRipwire(root, args, RIPWIRE_TIMEOUT_MS, signal, [0, 4]);
  return probe ? asResult(probe, `ripwire ${root} ${args[0]}`) : null;
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
  const probe = await runRipwire(root, ['--quality-delta'], RIPWIRE_TIMEOUT_MS, signal, [0, 2]);
  return probe ? asResult(probe, `ripwire ${root} --quality-delta`) : null;
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
    [`--pr-context=${baseSha}`, `--token-budget=${DEFAULT_MAX_TOKENS}`],
    RIPWIRE_TIMEOUT_MS,
    signal,
  );
  return output ? asResult(output, `ripwire ${root} --pr-context=${baseSha}`) : null;
}

/** Conservative token estimate (bytes / 4). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
