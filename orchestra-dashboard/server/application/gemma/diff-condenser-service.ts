import { callGemma, type JsonSchema } from '../../providers/lmstudio/chat-client.js';
import { parseJson, redactSecrets } from '../agents/agent-data-utils.js';

export interface CondensedDiffPacket {
  cleanDiff: string;
  authoritativeDiff: string;
  annotations: string;
  riskFlags: string[];
  strippedPaths: string[];
  estimatedTokens: number;
}

const DIFF_CONDENSER_SCHEMA: JsonSchema = {
  name: 'diff_condenser',
  schema: {
    type: 'object',
    properties: {
      annotations: { type: 'string' },
      riskFlags: { type: 'array', items: { type: 'string' } },
      noisePaths: { type: 'array', items: { type: 'string' } },
    },
    required: ['annotations', 'riskFlags', 'noisePaths'],
    additionalProperties: false,
  },
};

const NOISE_PATTERNS = [
  /^package-lock\.json$/i,
  /^yarn\.lock$/i,
  /^pnpm-lock\.yaml$/i,
  /^\.pnp\./,
  /\.min\.(js|css)$/i,
  /^dist\//i,
  /^build\//i,
  /^\.next\//i,
  /^coverage\//i,
  /^node_modules\//i,
  /\.map$/i,
  /\.d\.ts$/i,
  /^\.orchestra\//i,
  /^\.agents\//i,
];

/**
 * Use Gemma (local, free) to condense a raw git diff into a clean, focused
 * review packet for Codex. Strips noise (lockfiles, generated assets, build
 * output), annotates meaningful hunks relative to the original plan, and
 * flags potential risk areas.
 *
 * The condensed packet is what Codex receives — so Codex does not need to
 * run shell commands or explore the filesystem during review.
 */
export async function condenseDiff(input: {
  diff: string;
  changedFiles: string[];
  refinedSpec: string;
  implementationSummary: string;
  onUsage?: (usage: Record<string, number>) => void;
}): Promise<CondensedDiffPacket> {
  // Step 1: Deterministic noise stripping (no LLM needed)
  const { cleanDiff, strippedPaths } = stripNoisePaths(input.diff, input.changedFiles);

  if (!cleanDiff.trim()) {
    return {
      cleanDiff: '(All changes were in generated or lockfile paths.)',
      authoritativeDiff: input.diff,
      annotations: 'No meaningful code changes to review.',
      riskFlags: [],
      strippedPaths,
      estimatedTokens: 50,
    };
  }

  // Step 2: Deterministic Contract-Drift Detection (breaking schema/export changes)
  const driftFlags = detectContractDrift(cleanDiff);

  // Step 3: Gemma annotates the meaningful hunks and flags risks (free/local)
  const boundedDiff = cleanDiff.slice(0, 50_000);
  let annotations = '';
  let riskFlags: string[] = [...driftFlags];
  try {
    const raw = await callGemma([
      {
        role: 'system',
        content: `You are a diff analyst preparing a code review packet. Analyze the git diff below and provide:
1. A concise annotation of what each major change does relative to the implementation plan.
2. Risk flags for anything that could break existing functionality, introduce security issues, miss edge cases, or violate the plan scope.

Focus on substance, not formatting. Be concise. Return JSON only.`,
      },
      {
        role: 'user',
        content: `Implementation plan:\n${redactSecrets(input.refinedSpec).slice(0, 4_000)}\n\nImplementation summary:\n${redactSecrets(input.implementationSummary).slice(0, 3_000)}\n\nGit diff (noise paths already stripped):\n\`\`\`diff\n${redactSecrets(boundedDiff)}\n\`\`\``,
      },
    ], 1_200, 90_000, DIFF_CONDENSER_SCHEMA, false, undefined, input.onUsage);

    const value = parseJson(raw) as Record<string, unknown>;
    annotations = String(value.annotations || '').trim().slice(0, 4_000);
    const gemmaFlags = (Array.isArray(value.riskFlags) ? value.riskFlags : []).map(String).filter(Boolean);
    riskFlags = Array.from(new Set([...driftFlags, ...gemmaFlags])).slice(0, 15);
  } catch {
    // If Gemma is unavailable, the raw diff is still usable
    annotations = 'Local diff annotation was unavailable; review the diff directly.';
  }

  return {
    cleanDiff: boundedDiff,
    authoritativeDiff: input.diff,
    annotations,
    riskFlags,
    strippedPaths,
    estimatedTokens: Math.ceil(boundedDiff.length / 2),
  };
}

/**
 * Deterministic: Scan diff hunks for structural contract drift (deleted exports,
 * schema changes, removed test assertions). Zero LLM overhead.
 */
export function detectContractDrift(diff: string): string[] {
  const flags: string[] = [];
  const lines = diff.split('\n');

  let deletedExports = 0;
  let schemaModified = false;
  let testsRemoved = 0;

  for (const line of lines) {
    if (line.startsWith('---') || line.startsWith('+++')) {
      if (/schema|migration|models?\.ts/i.test(line)) schemaModified = true;
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      if (/^-\s*export\s+(?:interface|type|class|function|const|enum)\b/.test(line)) deletedExports += 1;
      if (/^-\s*(?:assert\.|expect\(|test\(|it\()/.test(line)) testsRemoved += 1;
    }
  }

  if (schemaModified) flags.push('CRITICAL: Database schema or migration files were modified.');
  if (deletedExports > 0) flags.push(`CONTRACT DRIFT: ${deletedExports} exported interface(s)/symbol(s) were removed or modified.`);
  if (testsRemoved > 0) flags.push(`TEST INTEGRITY: ${testsRemoved} test assertion(s) or case(s) were deleted.`);

  return flags;
}

/**
 * Deterministic: strip diff hunks belonging to noise paths (lockfiles,
 * generated assets, build output). No LLM call needed.
 */
function stripNoisePaths(diff: string, changedFiles: string[]): { cleanDiff: string; strippedPaths: string[] } {
  const strippedPaths: string[] = [];
  const meaningfulFiles = new Set<string>();

  for (const file of changedFiles) {
    const normalized = file.replaceAll('\\', '/');
    if (NOISE_PATTERNS.some((pattern) => pattern.test(normalized))) {
      strippedPaths.push(file);
    } else {
      meaningfulFiles.add(normalized);
    }
  }

  if (!strippedPaths.length) return { cleanDiff: diff, strippedPaths: [] };

  // Filter diff hunks: keep only hunks for meaningful files
  const lines = diff.split('\n');
  const output: string[] = [];
  let currentFile = '';
  let including = true;

  for (const line of lines) {
    const fileMatch = line.match(/^diff --git a\/(.+?) b\//);
    if (fileMatch) {
      currentFile = fileMatch[1];
      including = meaningfulFiles.has(currentFile);
    }
    if (including) output.push(line);
  }

  return { cleanDiff: output.join('\n'), strippedPaths };
}
