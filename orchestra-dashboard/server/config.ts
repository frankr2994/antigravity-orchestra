import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const dashboardRoot = resolve(moduleDir, '..');
const repoRoot = resolve(dashboardRoot, '..');
const localAppData = process.env.LOCALAPPDATA || resolve(process.cwd(), '.local-data');
const dataDir = process.env.ORCHESTRA_DATA_DIR || resolve(localAppData, 'AntigravityOrchestra');
mkdirSync(dataDir, { recursive: true });

export const JULES_ROLLOUT_STAGES = [
  'off',
  'connect',
  'read',
  'dispatch',
  'interact',
  'review',
  'repair',
  'integrate',
  'parallel',
  'auto',
] as const;

export type JulesRolloutStage = typeof JULES_ROLLOUT_STAGES[number];

export const EVIDENCE_MODES = ['legacy', 'snapshot'] as const;
export type EvidenceMode = typeof EVIDENCE_MODES[number];

export function parseEvidenceMode(value: string | undefined): EvidenceMode {
  return EVIDENCE_MODES.includes(value?.trim().toLowerCase() as EvidenceMode)
    ? value!.trim().toLowerCase() as EvidenceMode
    : 'legacy';
}

export function parseStrictBoolean(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

export function parseJulesRolloutStage(value: string | undefined): JulesRolloutStage {
  const normalized = value?.trim().toLowerCase();
  return JULES_ROLLOUT_STAGES.includes(normalized as JulesRolloutStage)
    ? normalized as JulesRolloutStage
    : 'connect';
}

export function hasJulesCapability(current: JulesRolloutStage, required: JulesRolloutStage): boolean {
  return JULES_ROLLOUT_STAGES.indexOf(current) >= JULES_ROLLOUT_STAGES.indexOf(required);
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

const julesEnabled = parseStrictBoolean(process.env.JULES_ENABLED);
const julesRolloutStage = julesEnabled
  ? parseJulesRolloutStage(process.env.JULES_ROLLOUT_STAGE)
  : 'off';

export const config = {
  host: '127.0.0.1',
  port: Number(process.env.ORCHESTRA_PORT || 3001),
  dashboardRoot,
  templateRoot: process.env.ORCHESTRA_TEMPLATE_ROOT || repoRoot,
  dataDir,
  databasePath: resolve(dataDir, 'orchestra.db'),
  uiToken: randomBytes(24).toString('hex'),
  lmStudioBaseUrl: process.env.LM_STUDIO_BASE_URL || 'http://127.0.0.1:1234/v1',
  lmStudioModel: process.env.LM_STUDIO_MODEL || '',
  maxGlobalTasks: 2,
  onboardingVersion: '1.0.0',
  evidenceMode: parseEvidenceMode(process.env.ORCHESTRA_EVIDENCE_MODE),
  jules: {
    enabled: julesEnabled,
    rolloutStage: julesRolloutStage,
    maxConcurrentSessions: boundedInteger(process.env.JULES_MAX_CONCURRENT_SESSIONS, 2, 1, 32),
    maxConcurrentPolls: boundedInteger(process.env.JULES_MAX_CONCURRENT_POLLS, 2, 1, 32),
    pollIntervalMs: boundedInteger(process.env.JULES_POLL_INTERVAL_MS, 5_000, 1_000, 300_000),
    pipelineTimeoutMs: boundedInteger(process.env.JULES_PIPELINE_TIMEOUT_MS, 45 * 60_000, 60_000, 6 * 60 * 60_000),
  },
};
