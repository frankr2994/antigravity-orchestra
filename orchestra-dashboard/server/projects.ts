import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { config } from './config.js';
import { commitPaths, getGitStatus, git, pushCurrent } from './git.js';
import type { Store } from './db.js';
import type { Project } from './types.js';

const MANAGED_BEGIN = '# BEGIN ANTIGRAVITY ORCHESTRA';
const MANAGED_END = '# END ANTIGRAVITY ORCHESTRA';
const GREENFIELD_ENTRIES = new Set(['AGENTS.md', '.agents', '.codex', '.gitignore', '.orchestra']);

export function isOrchestraInternalPath(path: string) {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
  return normalized === '.orchestra' || normalized.startsWith('.orchestra/');
}
const MANAGED_IGNORE = `${MANAGED_BEGIN}
# Local agent state and raw execution records
/.orchestra/
/logs/codex-responses/
/.agents/logs/

# Root-level scratch notes, logs, and generated captures
/*.log
/notes*.md
/scratch*.md
/todo-notes*.md
/*screenshot*.png
/*screenshot*.jpg
/*capture*.png

# Tool output
/coverage/
/.coverage
/.cache/
/node_modules/
/dist/
/build/
${MANAGED_END}`;

export function canonicalizeDirectory(input: string): string {
  if (!input || !isAbsolute(input)) throw new Error('An absolute project directory is required.');
  const resolved = realpathSync.native(resolve(input));
  const stat = lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('The project must be a real local directory, not a symbolic link.');
  return resolved;
}

export async function registerProject(store: Store, input: string): Promise<Project> {
  const root = canonicalizeDirectory(input);
  const status = await getGitStatus(root);
  return store.upsertProject({ name: basename(root), root, gitRoot: status.root });
}

export function inspectProjectScope(root: string, rootIsGitRepository = false) {
  const nestedRepositories: string[] = [];
  const visit = (directory: string, depth: number) => {
    if (depth > 2 || nestedRepositories.length >= 25) return;
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (nestedRepositories.length >= 25 || !entry.isDirectory() || entry.isSymbolicLink() || ['.git', 'node_modules', 'build', 'dist', '.cache'].includes(entry.name)) continue;
      const child = join(directory, entry.name);
      if (existsSync(join(child, '.git'))) nestedRepositories.push(relative(root, child).replaceAll('\\', '/'));
      else visit(child, depth + 1);
    }
  };
  if (!rootIsGitRepository) visit(root, 1);
  return {
    nestedRepositories,
    warning: nestedRepositories.length
      ? `This directory is a workspace containing ${nestedRepositories.length}${nestedRepositories.length === 25 ? '+' : ''} nested Git repositories. Select a specific repository root before running agent tasks.`
      : null,
  };
}

export async function onboardProject(store: Store, project: Project) {
  const before = await getGitStatus(project.root);
  const greenfield = !before.isGit && isGreenfieldDirectory(project.root);
  if (before.isGit && before.dirty && project.onboardingStatus === 'pending') {
    store.updateProjectOnboarding(project.id, 'blocked_dirty', null);
    return { status: 'blocked_dirty', commit: null, push: null };
  }

  store.updateProjectOnboarding(project.id, 'running', null);
  const changed: string[] = [];
  const backupRoot = join(project.root, '.orchestra', 'backups', timestamp());
  const manifest: Record<string, { source: string; hash: string }> = {};
  const items = ['AGENTS.md', '.agents', '.codex'];
  const isTemplateProject = realpathSync.native(project.root).toLowerCase() === realpathSync.native(config.templateRoot).toLowerCase();
  for (const item of items) {
    const source = join(config.templateRoot, item);
    if (!existsSync(source)) continue;
    const target = join(project.root, item);
    if (isTemplateProject) {
      manifest[item] = { source, hash: hashPath(source) };
      continue;
    }
    if (existsSync(target)) {
      const backup = join(backupRoot, item);
      mkdirSync(dirname(backup), { recursive: true });
      cpSync(target, backup, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
    cpSync(source, target, { recursive: true, force: true });
    changed.push(relative(project.root, target).replaceAll('\\', '/'));
    manifest[item] = { source, hash: hashPath(source) };
  }
  const ignoreChanged = updateManagedGitignore(project.root);
  if (ignoreChanged) changed.push('.gitignore');
  mkdirSync(join(project.root, '.orchestra'), { recursive: true });
  writeFileSync(join(project.root, '.orchestra', 'onboarding.json'), JSON.stringify({ version: config.onboardingVersion, installedAt: new Date().toISOString(), manifest }, null, 2));
  if (!before.isGit) {
    if (greenfield) return initializeGreenfieldRepository(store, project);
    store.updateProjectOnboarding(project.id, 'ready_non_git', config.onboardingVersion);
    return { status: 'ready_non_git', commit: null, push: null };
  }

  store.updateProjectOnboarding(project.id, 'ready', config.onboardingVersion);

  if (!changed.length) return { status: 'ready', commit: null, push: null };
  const after = await getGitStatus(project.root);
  const paths = after.files.map((file) => file.path).filter((path) => changed.some((item) => path === item || path.startsWith(`${item}/`)));
  if (!paths.length) return { status: 'ready', commit: null, push: null };
  const sha = await commitPaths(project.root, paths, 'chore: initialize Orchestra', `Install Orchestra ${config.onboardingVersion} project configuration.`);
  const push = await pushCurrent(project.root);
  return { status: push.pushed ? 'ready' : 'ready_unpushed', commit: sha, push };
}

export function isGreenfieldDirectory(root: string) {
  return readdirSync(root, { withFileTypes: true }).every((entry) => GREENFIELD_ENTRIES.has(entry.name));
}

export async function initializeGreenfieldRepository(store: Store, project: Project) {
  const before = await greenfieldGitStep('Inspecting the project before Git initialization', () => getGitStatus(project.root));
  if (before.isGit) return { status: 'ready', commit: before.head, push: null, initialized: false };
  if (!isGreenfieldDirectory(project.root)) {
    return { status: 'ready_non_git', commit: null, push: null, initialized: false };
  }
  const initialized = await greenfieldGitStep('Initializing Git', () => git(['init', '-b', 'main'], project.root));
  if (initialized.code !== 0) throw new Error(initialized.stderr || initialized.stdout || 'Unable to initialize the greenfield Git repository.');
  const pending = await greenfieldGitStep('Inspecting bootstrap files', () => getGitStatus(project.root));
  if (!pending.isGit || !pending.root) throw new Error('Git initialization completed without producing a detectable repository.');
  store.upsertProject({ name: project.name, root: project.root, gitRoot: pending.root });
  if (!pending.files.length) throw new Error('The greenfield repository has no bootstrap files to baseline.');
  const sha = await greenfieldGitStep('Creating the greenfield baseline commit', () => commitPaths(project.root, pending.files.map((file) => file.path), 'chore: initialize Orchestra', `Initialize a greenfield project with Orchestra ${config.onboardingVersion} configuration.`));
  const current = await greenfieldGitStep('Verifying the greenfield baseline', () => getGitStatus(project.root));
  const push = await greenfieldGitStep('Checking whether the baseline can be pushed', () => pushCurrent(project.root));
  const status = push.pushed ? 'ready' : 'ready_unpushed';
  store.updateProjectOnboarding(project.id, status, config.onboardingVersion);
  store.createGitOperation(project.id, null, 'onboarding', sha, current.branch, push.pushed ? 'pushed' : 'unpushed', push.error);
  return { status, commit: sha, push, initialized: true };
}

async function greenfieldGitStep<T>(label: string, action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) { throw new Error(`${label} failed: ${error instanceof Error ? error.message : String(error)}`); }
}

export function updateManagedGitignore(root: string): boolean {
  const path = join(root, '.gitignore');
  const original = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const expression = new RegExp(`${escapeRegex(MANAGED_BEGIN)}[\\s\\S]*?${escapeRegex(MANAGED_END)}\\s*`, 'm');
  const without = original.replace(expression, '').trimEnd();
  const updated = `${without}${without ? '\n\n' : ''}${MANAGED_IGNORE}\n`;
  if (updated === original) return false;
  const temporary = `${path}.orchestra-tmp`;
  writeFileSync(temporary, updated, 'utf8');
  renameSync(temporary, path);
  return true;
}

function timestamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }
function escapeRegex(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function hashPath(path: string): string {
  const hash = createHash('sha256');
  const stat = lstatSync(path);
  if (stat.isFile()) hash.update(readFileSync(path)); else hash.update(`${path}:${stat.mtimeMs}`);
  return hash.digest('hex');
}
