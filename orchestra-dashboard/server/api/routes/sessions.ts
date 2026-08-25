import { Router } from 'express';
import type { Store } from '../../db.js';
import type { TaskManager } from '../../tasks.js';
import { config } from '../../config.js';
import { buildContinuationPrompt, findContinuationRecoveryTask } from '../../agents.js';
import { ApplicationError } from '../../application/errors.js';

export function generateDynamicSessionTitle(prompt: string): string {
  const clean = prompt
    .replace(/^[\s#*`>_~-]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return 'New conversation';
  const firstSentence = clean.split(/[.!?\r\n]/)[0]?.trim() || clean;
  const candidate = firstSentence.length > 50 ? firstSentence.slice(0, 47).trim() + '…' : firstSentence;
  return candidate || 'New conversation';
}

export function createSessionsRouter(store: Store, tasks: TaskManager): Router {
  const router = Router();

  function requireProject(id: string) {
    const value = store.getProject(id);
    if (!value) throw new ApplicationError('PROJECT_NOT_FOUND', 'Project not found.', 404);
    return value;
  }

  function requireSession(id: string) {
    const value = store.getSession(id);
    if (!value) throw new ApplicationError('SESSION_NOT_FOUND', 'Conversation not found.', 404);
    return value;
  }

  router.get('/projects/:id/sessions', (req, res) => {
    res.json(store.listSessions(requireProject(req.params.id).id));
  });

  router.post('/projects/:id/sessions', (req, res) => {
    res.status(201).json(
      store.createSession(requireProject(req.params.id).id, String(req.body?.title || 'New conversation').slice(0, 80))
    );
  });

  router.patch('/sessions/:id', (req, res) => {
    const session = requireSession(req.params.id);
    const title = String(req.body?.title || '').trim().slice(0, 80);
    if (!title) {
      res.status(400).json({ error: 'Session title cannot be empty.' });
      return;
    }
    const updated = store.updateSessionTitle(session.id, title);
    res.json(updated || session);
  });

  router.delete('/sessions/:id', (req, res) => {
    const session = requireSession(req.params.id);
    store.deleteSession(session.id);
    res.status(204).end();
  });

  router.get('/sessions/:id/messages', (req, res) => {
    requireSession(req.params.id);
    res.json(store.listMessages(req.params.id));
  });

  router.post('/sessions/:id/activate', (req, res) => {
    const session = requireSession(req.params.id);
    store.activateSession(session.id, session.projectId);
    res.json(session);
  });

  // Task submission under session
  router.post('/sessions/:id/tasks', async (req, res, next) => {
    try {
      const session = requireSession(req.params.id);
      const prompt = String(req.body?.prompt || '').trim();
      if (!prompt || prompt.length > 100_000) {
        throw new Error('A prompt between 1 and 100,000 characters is required.');
      }
      const sessionTasks = store.listTasks(session.projectId).filter((candidate) => candidate.sessionId === session.id);
      const existingTask = await tasks.reconcileProjectOwner(session.projectId);
      const recoveryTask = existingTask?.sessionId === session.id
        ? findContinuationRecoveryTask(prompt, sessionTasks.filter((candidate) => candidate.id === existingTask.id))
        : null;
      if (recoveryTask) {
        store.addMessage({ sessionId: session.id, taskId: recoveryTask.id, role: 'user', agent: 'system', content: prompt });
        store.addEvent(recoveryTask.id, 'system', 'task.continuation', {
          previousTaskId: recoveryTask.id,
          message: 'The continuation command is resuming the existing task that owns the preserved changes.',
        });
        const recovered = await tasks.recover(recoveryTask.id);
        res.status(202).json(recovered);
        return;
      }
      if (existingTask) {
        throw new ApplicationError('PROJECT_TASK_ACTIVE', `“${existingTask.title}” is ${existingTask.state.replaceAll('_', ' ')} in another task (${existingTask.id}).`, 409,
          { nextAction: 'Open its conversation using the active-task notice, then resume, commit, or stop it.', retryable: false });
      }
      if (session.title === 'New conversation' || session.title.startsWith('New conversation')) {
        const dynamicTitle = generateDynamicSessionTitle(prompt);
        if (dynamicTitle && dynamicTitle !== 'New conversation') {
          store.updateSessionTitle(session.id, dynamicTitle);
        }
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
          antigravityEffort: directAgent === 'antigravity' ? directEffort : ('high' as const),
          codex: directAgent === 'codex' ? (directModel || 'gpt-5.6-sol') : null,
          codexEffort: directAgent === 'codex' ? directEffort : null,
        };
        initialModels = JSON.stringify(mod);
      }

      const previousTask = sessionTasks[0] || null;
      const continuationPrompt = mode === 'orchestra' ? buildContinuationPrompt(prompt, previousTask) : null;
      const task = store.createTask(session.projectId, session.id, continuationPrompt || prompt, initialClassification, initialModels);
      store.addMessage({ sessionId: session.id, taskId: task.id, role: 'user', agent: 'system', content: prompt });
      if (continuationPrompt && previousTask) {
        store.addEvent(task.id, 'system', 'task.continuation', {
          previousTaskId: previousTask.id,
          message: 'Continuing the prior task with explicit implementation authorization.',
        });
      }
      tasks.enqueue(task.id);
      res.status(202).json(task);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
