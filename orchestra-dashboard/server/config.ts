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

export const config = {
  host: '127.0.0.1',
  port: Number(process.env.ORCHESTRA_PORT || 3001),
  dashboardRoot,
  templateRoot: process.env.ORCHESTRA_TEMPLATE_ROOT || repoRoot,
  dataDir,
  databasePath: resolve(dataDir, 'orchestra.db'),
  uiToken: randomBytes(24).toString('hex'),
  lmStudioBaseUrl: process.env.LM_STUDIO_BASE_URL || 'http://127.0.0.1:1234/v1',
  lmStudioModel: process.env.LM_STUDIO_MODEL || 'gemma-4-e2b-it-qat',
  maxGlobalTasks: 2,
  onboardingVersion: '1.0.0',
};
