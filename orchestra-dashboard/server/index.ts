import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { Store } from './db.js';
import { TaskManager } from './tasks.js';
import { canonicalizeDirectory, inspectProjectScope, isOrchestraInternalPath, onboardProject, registerProject } from './projects.js';
import { createManualCheckpoint, getCommitDiffDetails, getGitStatus, getProjectCheckpoints, pushCurrent, revertToCheckpoint } from './git.js';
import { getAntigravityModels, getCodexModels, getHealth, getStats, getUsage } from './telemetry.js';
import { runProcess } from './process.js';
import { answerRunQuestion, buildContinuationPrompt, DEFAULT_QUOTA_POLICY, explainRunHealth, findContinuationRecoveryTask, getInstalledLmStudioModels, loadLmStudioModel, type QuotaPolicy, suggestSteeringGuidance, unloadLmStudioModel } from './agents.js';
import { ensureAntigravityStatusCollector } from './observability.js';
import { closeCodexAppServer } from './codex-app-server.js';
import { getMcpStatus, listAllMcpServers, toggleMcpServer } from './mcp.js';
import { getComfyStatus } from './comfy.js';
import { deleteForgeAsset, getForgeAsset, listForgeAssets, repairForgeAsset, reviewForgeAsset, runForge3DJob } from './forge3d.js';
import { checkForgeDependencies, getDownloadProgress, installForgeDependency } from './forge-manifest.js';
import { exportModelFormat } from './mesh-qa.js';

const app = express();
const store = new Store();
const recoveredTasks = store.recoverInterruptedTasks();
const interruptedTasks = [...new Set([
  ...recoveredTasks,
  ...store.listTasks().filter((task) => task.state === 'failed' && /dashboard restarted while this task was running/i.test(task.error || '')).map((task) => task.id),
])];
for (const taskId of interruptedTasks) await restoreInterruptedTask(taskId);
if (interruptedTasks.length) console.warn(`Reconciled ${interruptedTasks.length} interrupted task(s) after restart.`);
const tasks = new TaskManager(store, config.maxGlobalTasks);
const antigravityCollector = ensureAntigravityStatusCollector();
if (!antigravityCollector.configured) console.warn(`Antigravity telemetry: ${antigravityCollector.reason}`);
const allowedHosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`, '127.0.0.1:5173', 'localhost:5173']);

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  const host = req.headers.host || '';
  if (!allowedHosts.has(host)) return res.status(403).json({ error: 'Invalid host.' });
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use('/api', (req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.headers.origin;
    if (origin) {
      try { if (!allowedHosts.has(new URL(origin).host)) return res.status(403).json({ error: 'Invalid request origin.' }); }
      catch { return res.status(403).json({ error: 'Invalid request origin.' }); }
    }
    if (req.headers['x-orchestra-token'] !== config.uiToken) return res.status(403).json({ error: 'Invalid dashboard token.' });
  }
  next();
});

app.get('/api/bootstrap', async (_req, res) => {
  res.json({ token: config.uiToken, settings: publicSettings(), projects: store.listProjects(), tasks: store.listTasks(), health: await getHealth() });
});
app.get('/api/health', async (_req, res) => res.json(await getHealth()));
app.get('/api/stats', async (_req, res, next) => { try { res.json(await getStats()); } catch (error) { next(error); } });
app.get('/api/usage', async (_req, res, next) => { try { res.json(await getUsage()); } catch (error) { next(error); } });
app.get('/api/mcp/status', async (_req, res, next) => { try { res.json(await getMcpStatus()); } catch (error) { next(error); } });

app.post('/api/projects/pick', async (_req, res, next) => {
  try { const path = await pickFolder(); res.json({ path }); } catch (error) { next(error); }
});
app.get('/api/projects', (_req, res) => res.json(store.listProjects()));
app.post('/api/projects', async (req, res, next) => {
  try {
    const project = await registerProject(store, String(req.body?.path || ''));
    const scope = inspectProjectScope(project.root, Boolean(project.gitRoot));
    const onboarding = scope.warning
      ? (store.updateProjectOnboarding(project.id, 'scope_warning', null), { status: 'scope_warning', commit: null, push: null })
      : await onboardProject(store, project);
    res.status(201).json({ project: store.getProject(project.id), onboarding, scope, git: await getGitStatus(project.root) });
  } catch (error) { next(error); }
});
app.post('/api/projects/:id/activate', async (req, res, next) => {
  try {
    const project = requireProject(req.params.id);
    canonicalizeDirectory(project.root);
    const scope = inspectProjectScope(project.root, Boolean(project.gitRoot));
    if (scope.warning) store.updateProjectOnboarding(project.id, 'scope_warning', null);
    let sessions = store.listSessions(project.id);
    if (!sessions.length) sessions = [store.createSession(project.id)];
    res.json({ project: store.getProject(project.id), sessions, activeSession: sessions.find((item) => item.id === project.activeSessionId) || sessions[0], scope, git: await getGitStatus(project.root) });
  } catch (error) { next(error); }
});
app.delete('/api/projects/:id', (req, res) => { store.forgetProject(req.params.id); res.status(204).end(); });

function generateDynamicSessionTitle(prompt: string): string {
  const clean = prompt
    .replace(/^[\s#*`>_~-]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return 'New conversation';
  const firstSentence = clean.split(/[.!?\r\n]/)[0]?.trim() || clean;
  const candidate = firstSentence.length > 50 ? firstSentence.slice(0, 47).trim() + '…' : firstSentence;
  return candidate || 'New conversation';
}

app.get('/api/projects/:id/sessions', (req, res) => res.json(store.listSessions(requireProject(req.params.id).id)));
app.post('/api/projects/:id/sessions', (req, res) => res.status(201).json(store.createSession(requireProject(req.params.id).id, String(req.body?.title || 'New conversation').slice(0, 80))));
app.patch('/api/sessions/:id', (req, res) => {
  const session = requireSession(req.params.id);
  const title = String(req.body?.title || '').trim().slice(0, 80);
  if (!title) {
    res.status(400).json({ error: 'Session title cannot be empty.' });
    return;
  }
  const updated = store.updateSessionTitle(session.id, title);
  res.json(updated || session);
});
app.delete('/api/sessions/:id', (req, res) => {
  const session = requireSession(req.params.id);
  store.deleteSession(session.id);
  res.status(204).end();
});
app.get('/api/sessions/:id/messages', (req, res) => { requireSession(req.params.id); res.json(store.listMessages(req.params.id)); });
app.post('/api/sessions/:id/activate', (req, res) => { const session = requireSession(req.params.id); store.activateSession(session.id, session.projectId); res.json(session); });

app.post('/api/sessions/:id/tasks', async (req, res, next) => {
  try {
    const session = requireSession(req.params.id);
    const existingTaskId = tasks.activeTaskId(session.projectId);
    if (existingTaskId) throw new Error(`This project already has an active or queued task (${existingTaskId}). Open that task instead of creating a duplicate.`);
    const prompt = String(req.body?.prompt || '').trim();
    if (!prompt || prompt.length > 100_000) throw new Error('A prompt between 1 and 100,000 characters is required.');
    if (session.title === 'New conversation' || session.title.startsWith('New conversation')) {
      const dynamicTitle = generateDynamicSessionTitle(prompt);
      if (dynamicTitle && dynamicTitle !== 'New conversation') {
        store.updateSessionTitle(session.id, dynamicTitle);
      }
    }
    const sessionTasks = store.listTasks(session.projectId).filter((candidate) => candidate.sessionId === session.id);
    const recoveryTask = findContinuationRecoveryTask(prompt, sessionTasks);
    if (recoveryTask) {
      store.addMessage({ sessionId: session.id, taskId: recoveryTask.id, role: 'user', agent: 'system', content: prompt });
      store.addEvent(recoveryTask.id, 'system', 'task.continuation', { previousTaskId: recoveryTask.id, message: 'The continuation command is resuming the existing task that owns the preserved changes.' });
      const recovered = await tasks.recover(recoveryTask.id);
      res.status(202).json(recovered);
      return;
    }
    const mode = req.body?.mode === 'direct' ? 'direct' : 'orchestra';
    const directAgent = req.body?.directAgent === 'codex' ? 'codex' : req.body?.directAgent === 'antigravity' ? 'antigravity' : 'gemma';
    let initialClassification: string | null = null;
    let initialModels: string | null = null;
    if (mode === 'direct') {
      const directModel = typeof req.body?.directModel === 'string' && req.body.directModel.trim() ? req.body.directModel.trim() : null;
      const directEffort = req.body?.directEffort === 'low' || req.body?.directEffort === 'medium' || req.body?.directEffort === 'high' ? req.body.directEffort : 'high';

      const cls = {
        type: 'question' as const,
        mutating: false,
        complexity: 'small' as const,
        riskFlags: [],
        codexRole: 'none' as const,
        executionMode: 'direct' as const,
        directAgent,
        directModel: directModel || undefined,
        directEffort: directEffort || undefined,
        title: prompt.slice(0, 72),
      };
      initialClassification = JSON.stringify(cls);
      const mod = {
        primary: directAgent,
        gemma: directAgent === 'gemma' ? (directModel || config.lmStudioModel) : config.lmStudioModel,
        antigravity: directAgent === 'antigravity' ? (directModel || 'gemini-3.7-flash-high') : 'gemini-3.7-flash-high',
        antigravityEffort: directAgent === 'antigravity' ? directEffort : 'high' as const,
        codex: directAgent === 'codex' ? (directModel || 'gpt-5.6-sol') : null,
        codexEffort: directAgent === 'codex' ? directEffort : null,
      };
      initialModels = JSON.stringify(mod);
    }

    const previousTask = sessionTasks[0] || null;
    const continuationPrompt = mode === 'orchestra' ? buildContinuationPrompt(prompt, previousTask) : null;
    const task = store.createTask(session.projectId, session.id, continuationPrompt || prompt, initialClassification, initialModels);
    store.addMessage({ sessionId: session.id, taskId: task.id, role: 'user', agent: 'system', content: prompt });
    if (continuationPrompt && previousTask) store.addEvent(task.id, 'system', 'task.continuation', { previousTaskId: previousTask.id, message: 'Continuing the prior task with explicit implementation authorization.' });
    tasks.enqueue(task.id);
    res.status(202).json(task);
  } catch (error) { next(error); }
});
app.get('/api/tasks', (req, res) => res.json(store.listTasks(typeof req.query.projectId === 'string' ? req.query.projectId : undefined)));
app.get('/api/projects/:id/active-task', (req, res) => {
  const project = requireProject(req.params.id);
  const id = tasks.activeTaskId(project.id);
  res.json(id ? requireTask(id) : null);
});
app.get('/api/tasks/:id', (req, res) => res.json(requireTask(req.params.id)));
app.get('/api/tasks/:id/monitor', async (req, res, next) => {
  try { res.json(await tasks.getMonitor(requireTask(req.params.id).id)); } catch (error) { next(error); }
});
app.post('/api/tasks/:id/monitor/explain', async (req, res, next) => {
  try {
    const monitor = await tasks.getMonitor(requireTask(req.params.id).id);
    const explanation = await explainRunHealth({ ...monitor, changedFiles: monitor.changedFiles.slice(0, 30), stopReason: monitor.stopReason?.slice(0, 2000) || null });
    res.json({ explanation });
  } catch (error) { next(error); }
});
app.post('/api/tasks/:id/monitor/ask', async (req, res, next) => {
  try {
    const task = requireTask(req.params.id);
    const question = String(req.body?.question || '').trim();
    if (!question || question.length > 4_000) throw new Error('A monitor question between 1 and 4,000 characters is required.');
    const monitor = await tasks.getMonitor(task.id);
    const events = store.listEvents(task.id).slice(-100).map((event) => ({ agent: event.agent, type: event.type, createdAt: event.createdAt, payload: event.payload }));
    const answer = await answerRunQuestion(question, { task: { state: task.state, classification: task.classification, models: task.models, error: task.error }, monitor, events });
    res.json({ answer });
  } catch (error) { next(error); }
});
app.get('/api/tasks/:id/events', (req, res) => {
  requireTask(req.params.id);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'Cache-Control': 'no-cache, no-transform' });
  const after = Number(req.headers['last-event-id'] || req.query.after || 0);
  for (const event of store.listEvents(req.params.id, after)) writeEvent(res, event);
  const unsubscribe = tasks.subscribe(req.params.id, (event) => writeEvent(res, event));
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
  req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
});
app.post('/api/tasks/:id/cancel', (req, res) => { tasks.cancel(requireTask(req.params.id).id); res.status(202).json({ ok: true }); });
app.post('/api/tasks/:id/recover', async (req, res, next) => {
  try { const task = await tasks.recover(requireTask(req.params.id).id); res.status(202).json(task); } catch (error) { next(error); }
});
app.post('/api/tasks/:id/retry', async (req, res, next) => {
  try { await tasks.retry(requireTask(req.params.id).id); res.status(202).json({ ok: true }); } catch (error) { next(error); }
});
app.post('/api/tasks/:id/approve-disputed', async (req, res, next) => {
  try { const task = await tasks.approveDisputed(requireTask(req.params.id).id); res.status(202).json(task); } catch (error) { next(error); }
});
app.post('/api/tasks/:id/steer-disputed', async (req, res, next) => {
  try {
    const guidance = String(req.body?.guidance || '').trim();
    const task = await tasks.steerDisputed(requireTask(req.params.id).id, guidance);
    res.status(202).json(task);
  } catch (error) { next(error); }
});
app.post('/api/projects/:id/baseline', async (req, res, next) => {
  try { requireProject(req.params.id); const task = requireTask(String(req.body?.taskId || '')); await tasks.resolveBaseline(task.id); res.status(202).json({ ok: true }); } catch (error) { next(error); }
});
app.post('/api/tasks/:id/retry-push', async (req, res, next) => {
  try {
    const task = requireTask(req.params.id); const project = requireProject(task.projectId);
    const result = await pushCurrent(project.root);
    store.updateTask(task.id, { pushStatus: result.pushed ? 'pushed' : 'unpushed', state: result.pushed ? 'completed' : 'completed_unpushed' });
    res.json(result);
  } catch (error) { next(error); }
});

app.get('/api/projects/:id/checkpoints', async (req, res, next) => {
  try {
    const project = requireProject(req.params.id);
    const tasks = store.listTasks(project.id);
    const result = await getProjectCheckpoints(project.root, tasks);
    res.json(result);
  } catch (error) { next(error); }
});

app.get('/api/projects/:id/checkpoints/:sha/diff', async (req, res, next) => {
  try {
    const project = requireProject(req.params.id);
    const result = await getCommitDiffDetails(project.root, req.params.sha);
    res.json(result);
  } catch (error) { next(error); }
});

app.post('/api/projects/:id/checkpoints/create', async (req, res, next) => {
  try {
    const project = requireProject(req.params.id);
    const message = typeof req.body?.message === 'string' ? req.body.message : 'manual checkpoint';
    const result = await createManualCheckpoint(project.root, message);
    res.json(result);
  } catch (error) { next(error); }
});

app.post('/api/projects/:id/checkpoints/:sha/revert', async (req, res, next) => {
  try {
    const project = requireProject(req.params.id);
    const mode = req.body?.mode === 'branch' ? 'branch' : 'rollback';
    const branchName = typeof req.body?.branchName === 'string' ? req.body.branchName : undefined;
    const result = await revertToCheckpoint(project.root, req.params.sha, { mode, branchName });
    res.json(result);
  } catch (error) { next(error); }
});

app.get('/api/mcp/servers', async (req, res, next) => {
  try {
    const force = req.query.force === 'true';
    const servers = await listAllMcpServers(force);
    res.json(servers);
  } catch (error) { next(error); }
});

app.post('/api/mcp/servers/:name/toggle', async (req, res, next) => {
  try {
    const enabled = Boolean(req.body?.enabled);
    const updated = await toggleMcpServer(req.params.name, enabled);
    res.json({ ok: true, server: updated });
  } catch (error) { next(error); }
});

app.post('/api/tasks/:id/suggest-steering', async (req, res, next) => {
  try {
    const task = requireTask(req.params.id);
    const project = requireProject(task.projectId);
    const events = store.listEvents(task.id);
    const lastReviewEvent = events.findLast((e) => e.type === 'agent.completed' && ((e.payload as Record<string, unknown> | null)?.role === 'review'));
    const payload = lastReviewEvent?.payload as Record<string, unknown> | undefined;
    const reviewBlockers = typeof payload?.summary === 'string' ? payload.summary : 'Review was rejected without specific blockers.';
    const suggestion = await suggestSteeringGuidance({
      root: project.root,
      request: task.prompt,
      reviewBlockers,
    });
    res.json({ suggestion });
  } catch (error) { next(error); }
});

app.get('/api/models', async (_req, res, next) => {
  try {
    const [antigravity, codex, lmStudio] = await Promise.all([
      getAntigravityModels(),
      getCodexModels(),
      getInstalledLmStudioModels().catch(() => []),
    ]);
    res.json({ antigravity, codex, lmStudio });
  } catch (error) { next(error); }
});

app.get('/api/lmstudio/models', async (_req, res, next) => {
  try {
    const models = await getInstalledLmStudioModels();
    res.json({ models });
  } catch (error) { next(error); }
});

app.post('/api/lmstudio/load', async (req, res, next) => {
  try {
    const modelId = typeof req.body?.modelId === 'string' ? req.body.modelId.trim() : '';
    if (!modelId) return res.status(400).json({ error: 'modelId is required.' });
    const result = await loadLmStudioModel(modelId, { gpu: req.body?.gpu, contextLength: req.body?.contextLength });
    if (result.ok && result.activeModel) {
      store.setSetting('lmStudioModel', result.activeModel);
    }
    res.json(result);
  } catch (error) { next(error); }
});

app.post('/api/lmstudio/unload', async (req, res, next) => {
  try {
    const modelId = typeof req.body?.modelId === 'string' ? req.body.modelId.trim() : undefined;
    const result = await unloadLmStudioModel(modelId);
    res.json(result);
  } catch (error) { next(error); }
});

app.get('/api/settings', (_req, res) => res.json(publicSettings()));
app.patch('/api/settings', (req, res) => {
  const interval = Number(req.body?.telemetryInterval);
  if (Number.isFinite(interval) && interval >= 1000 && interval <= 60_000) store.setSetting('telemetryInterval', String(interval));
  if (typeof req.body?.lmStudioModel === 'string' && req.body.lmStudioModel.trim()) {
    store.setSetting('lmStudioModel', req.body.lmStudioModel.trim());
  }
  if (req.body?.quotaPolicy && typeof req.body.quotaPolicy === 'object') {
    store.setSetting('quotaPolicy', JSON.stringify(req.body.quotaPolicy));
  }
  res.json(publicSettings());
});

app.get('/api/forge3d/status', async (_req, res) => {
  const comfy = await getComfyStatus();
  res.json({
    comfy,
    lmStudio: {
      url: config.lmStudioBaseUrl,
      model: config.lmStudioModel,
    },
  });
});

app.get('/api/forge3d/setup/status', async (_req, res, next) => {
  try {
    res.json(await checkForgeDependencies());
  } catch (error) {
    next(error);
  }
});

app.post('/api/forge3d/setup/install', async (req, res, next) => {
  try {
    const depId = String(req.body?.depId || '').trim();
    if (!depId) throw new Error('Dependency ID is required.');
    void installForgeDependency(depId).catch((err) => console.error(`Forge install error for ${depId}:`, err));
    res.json({ started: true, depId });
  } catch (error) {
    next(error);
  }
});

app.get('/api/forge3d/setup/progress', (_req, res) => {
  res.json({ progress: getDownloadProgress() });
});

app.get('/api/forge3d/assets', (_req, res) => {
  res.json(listForgeAssets());
});

app.get('/api/forge3d/assets/:filename', (req, res) => {
  const file = join(config.dataDir, 'forge3d', req.params.filename);
  if (!existsSync(file)) {
    res.status(404).json({ error: '3D Asset file not found.' });
    return;
  }
  if (req.params.filename.endsWith('.glb')) {
    res.setHeader('Content-Type', 'model/gltf-binary');
  } else if (req.params.filename.endsWith('.png')) {
    res.setHeader('Content-Type', 'image/png');
  }
  res.sendFile(file);
});

app.delete('/api/forge3d/assets/:id', (req, res) => {
  const success = deleteForgeAsset(req.params.id);
  res.status(success ? 204 : 404).end();
});

app.post('/api/forge3d/assets/:id/review', async (req, res, next) => {
  try {
    const imagesBase64 = Array.isArray(req.body?.imagesBase64) ? req.body.imagesBase64 : [];
    if (!imagesBase64.length) {
      throw new Error('imagesBase64 array containing rendered canvas views is required.');
    }
    const review = await reviewForgeAsset(req.params.id, imagesBase64);
    res.json(review);
  } catch (error) {
    next(error);
  }
});

app.post('/api/forge3d/assets/:id/repair', async (req, res, next) => {
  try {
    const repaired = await repairForgeAsset(req.params.id);
    res.json(repaired);
  } catch (error) {
    next(error);
  }
});

app.get('/api/forge3d/assets/:id/export', async (req, res, next) => {
  try {
    const asset = getForgeAsset(req.params.id);
    if (!asset) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    const format = String(req.query.format || 'glb').toLowerCase() as 'glb' | 'obj' | 'stl';
    if (format === 'glb') {
      res.setHeader('Content-Disposition', `attachment; filename="${asset.id}.glb"`);
      return res.sendFile(asset.modelPath);
    }

    if (format === 'obj' || format === 'stl') {
      const exportPath = asset.modelPath.replace(/\.glb$/i, `.${format}`);
      await exportModelFormat(asset.modelPath, format, exportPath);
      res.setHeader('Content-Disposition', `attachment; filename="${asset.id}.${format}"`);
      return res.sendFile(exportPath);
    }

    res.status(400).json({ error: `Unsupported export format: ${format}. Supported: glb, obj, stl.` });
  } catch (error) {
    next(error);
  }
});

app.post('/api/forge3d/generate', async (req, res, next) => {
  try {
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : undefined;
    const mode = (req.body?.mode === 'image_to_3d' ? 'image_to_3d' : 'text_to_3d') as 'text_to_3d' | 'image_to_3d';
    const style = String(req.body?.style || 'stylized');
    const autoReview = req.body?.autoReview !== false;

    let imageFilename = typeof req.body?.imageFilename === 'string' ? req.body.imageFilename.trim() : undefined;
    let imageBuffer: Buffer | undefined;

    if (req.body?.imageBase64 && typeof req.body.imageBase64 === 'string') {
      const cleanB64 = req.body.imageBase64.replace(/^data:image\/[a-z]+;base64,/, '');
      imageBuffer = Buffer.from(cleanB64, 'base64');
      if (!imageFilename) {
        imageFilename = `upload_${Date.now()}.png`;
      }
    }

    const asset = await runForge3DJob({
      prompt,
      mode,
      style,
      autoReview,
      imageFilename,
      imageBuffer,
    });
    res.status(201).json(asset);
  } catch (error) {
    next(error);
  }
});

const publicDir = join(config.dashboardRoot, 'dist');
if (existsSync(publicDir)) {
  app.use(express.static(publicDir, { index: false }));
  app.get('*path', (_req, res) => res.sendFile(join(publicDir, 'index.html')));
}

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  res.status(/not found/i.test(message) ? 404 : 400).json({ error: message });
});

const server = app.listen(config.port, config.host, () => console.log(`Orchestra Command Center: http://${config.host}:${config.port}`));
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') console.error(`Port ${config.port} is already in use. Stop the legacy dashboard backend before starting Orchestra.`);
  else console.error(error);
  process.exitCode = 1;
});
function shutdown() { closeCodexAppServer(); server.close(() => { store.close(); process.exit(0); }); setTimeout(() => process.exit(1), 5000).unref(); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);

function requireProject(id: string) { const value = store.getProject(id); if (!value) throw new Error('Project not found.'); return value; }
function requireSession(id: string) { const value = store.getSession(id); if (!value) throw new Error('Conversation not found.'); return value; }
function requireTask(id: string) { const value = store.getTask(id); if (!value) throw new Error('Task not found.'); return value; }
async function restoreInterruptedTask(taskId: string) {
  const task = store.getTask(taskId);
  if (!task) return;
  let classification: { mutating?: boolean } | null = null;
  try { classification = task.classification ? JSON.parse(task.classification) as { mutating?: boolean } : null; } catch { /* Leave malformed historical metadata failed. */ }
  const project = store.getProject(task.projectId);
  if (!classification?.mutating || !project) return;
  try {
    const status = await getGitStatus(project.root);
    const files = status.files.filter((file) => !isOrchestraInternalPath(file.path));
    if (!status.isGit || !files.length) return;
    const message = 'The dashboard restarted during this task. Its uncommitted project changes were preserved and can continue through automatic repair and review.';
    store.updateTask(taskId, { state: 'recovery_required', error: message });
    store.addEvent(taskId, 'system', 'task.recovery-required', { message, files });
    store.addEvent(taskId, 'system', 'task.state', { state: 'recovery_required' });
  } catch { /* Preserve the ordinary interrupted failure if Git inspection fails. */ }
}
function writeEvent(res: Response, event: { id: number; type: string }) { res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); }
function publicSettings() {
  const quotaPolicyJson = store.getSetting('quotaPolicy');
  let quotaPolicy: QuotaPolicy = DEFAULT_QUOTA_POLICY;
  try { if (quotaPolicyJson) quotaPolicy = { ...DEFAULT_QUOTA_POLICY, ...JSON.parse(quotaPolicyJson) }; } catch { /* ignore */ }
  const lmStudioModel = store.getSetting('lmStudioModel') || config.lmStudioModel;
  return {
    lmStudioBaseUrl: config.lmStudioBaseUrl,
    lmStudioModel,
    telemetryInterval: Number(store.getSetting('telemetryInterval') || 2000),
    maxGlobalTasks: config.maxGlobalTasks,
    routingMode: 'automatic',
    quotaPolicy,
  };
}

async function pickFolder() {
  if (process.platform !== 'win32') throw new Error('Native folder selection is currently supported on Windows only.');
  const script = `Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = 'Select an active project directory'; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }`;
  const result = await runProcess('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { timeoutMs: 5 * 60_000 });
  if (result.code !== 0) throw new Error(result.stderr || 'Folder picker failed.');
  const path = result.stdout.trim();
  if (!path) throw new Error('Folder selection was cancelled.');
  return canonicalizeDirectory(path);
}
