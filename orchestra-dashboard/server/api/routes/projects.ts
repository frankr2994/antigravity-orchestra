import { Router } from 'express';
import type { Store } from '../../db.js';
import { canonicalizeDirectory, inspectProjectScope, onboardProject, registerProject } from '../../projects.js';
import { createManualCheckpoint, getCommitDiffDetails, getGitStatus, getProjectCheckpoints, revertToCheckpoint } from '../../git.js';
import { runProcess } from '../../process.js';

export async function pickFolder() {
  if (process.platform !== 'win32') {
    throw new Error('Native folder selection is currently supported on Windows only.');
  }
  const script = `Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = 'Select an active project directory'; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }`;
  const result = await runProcess('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { timeoutMs: 5 * 60_000 });
  if (result.code !== 0) throw new Error(result.stderr || 'Folder picker failed.');
  const path = result.stdout.trim();
  if (!path) throw new Error('Folder selection was cancelled.');
  return canonicalizeDirectory(path);
}

export function createProjectsRouter(store: Store): Router {
  const router = Router();

  function requireProject(id: string) {
    const value = store.getProject(id);
    if (!value) throw new Error('Project not found.');
    return value;
  }

  router.post('/projects/pick', async (_req, res, next) => {
    try {
      const path = await pickFolder();
      res.json({ path });
    } catch (error) {
      next(error);
    }
  });

  router.get('/projects', (_req, res) => {
    res.json(store.listProjects());
  });

  router.post('/projects', async (req, res, next) => {
    try {
      const project = await registerProject(store, String(req.body?.path || ''));
      const scope = inspectProjectScope(project.root, Boolean(project.gitRoot));
      const onboarding = scope.warning
        ? (store.updateProjectOnboarding(project.id, 'scope_warning', null), { status: 'scope_warning', commit: null, push: null })
        : await onboardProject(store, project);
      res.status(201).json({
        project: store.getProject(project.id),
        onboarding,
        scope,
        git: await getGitStatus(project.root),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/projects/:id/activate', async (req, res, next) => {
    try {
      const project = requireProject(req.params.id);
      canonicalizeDirectory(project.root);
      const scope = inspectProjectScope(project.root, Boolean(project.gitRoot));
      if (scope.warning) store.updateProjectOnboarding(project.id, 'scope_warning', null);
      let sessions = store.listSessions(project.id);
      if (!sessions.length) sessions = [store.createSession(project.id)];
      res.json({
        project: store.getProject(project.id),
        sessions,
        activeSession: sessions.find((item) => item.id === project.activeSessionId) || sessions[0],
        scope,
        git: await getGitStatus(project.root),
      });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/projects/:id', (req, res) => {
    store.forgetProject(req.params.id);
    res.status(204).end();
  });

  // Checkpoints
  router.get('/projects/:id/checkpoints', async (req, res, next) => {
    try {
      const project = requireProject(req.params.id);
      const tasks = store.listTasks(project.id);
      const result = await getProjectCheckpoints(project.root, tasks);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/projects/:id/checkpoints/:sha/diff', async (req, res, next) => {
    try {
      const project = requireProject(req.params.id);
      const result = await getCommitDiffDetails(project.root, req.params.sha);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/projects/:id/checkpoints/create', async (req, res, next) => {
    try {
      const project = requireProject(req.params.id);
      const message = typeof req.body?.message === 'string' ? req.body.message : 'manual checkpoint';
      const result = await createManualCheckpoint(project.root, message);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/projects/:id/checkpoints/:sha/revert', async (req, res, next) => {
    try {
      const project = requireProject(req.params.id);
      const mode = req.body?.mode === 'branch' ? 'branch' : 'rollback';
      const branchName = typeof req.body?.branchName === 'string' ? req.body.branchName : undefined;
      const result = await revertToCheckpoint(project.root, req.params.sha, { mode, branchName });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
