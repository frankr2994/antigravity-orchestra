import { Router } from 'express';
import type { Store } from '../../db.js';
import type { TaskManager } from '../../tasks.js';
import { answerRunQuestion, explainRunHealth } from '../../agents.js';
import { pushCurrent } from '../../git.js';
import { writeEvent } from '../sse/stream.js';
import { ApplicationError } from '../../application/errors.js';

export function createTasksRouter(store: Store, tasks: TaskManager): Router {
  const router = Router();

  function requireProject(id: string) {
    const value = store.getProject(id);
    if (!value) throw new ApplicationError('PROJECT_NOT_FOUND', 'Project not found.', 404);
    return value;
  }

  function requireTask(id: string) {
    const value = store.getTask(id);
    if (!value) throw new ApplicationError('TASK_NOT_FOUND', 'Task not found.', 404);
    return value;
  }

  router.get('/tasks', (req, res) => {
    res.json(store.listTasks(typeof req.query.projectId === 'string' ? req.query.projectId : undefined));
  });

  router.get('/projects/:id/active-task', (req, res) => {
    const project = requireProject(req.params.id);
    const id = tasks.activeTaskId(project.id);
    res.json(id ? requireTask(id) : null);
  });

  router.get('/tasks/:id', (req, res) => {
    res.json(requireTask(req.params.id));
  });

  router.get('/tasks/:id/monitor', async (req, res, next) => {
    try {
      res.json(await tasks.getMonitor(requireTask(req.params.id).id));
    } catch (error) {
      next(error);
    }
  });

  router.post('/api/tasks/:id/monitor/explain', async (req, res, next) => {
    try {
      const monitor = await tasks.getMonitor(requireTask(req.params.id).id);
      const explanation = await explainRunHealth({
        ...monitor,
        changedFiles: monitor.changedFiles.slice(0, 30),
        stopReason: monitor.stopReason?.slice(0, 2000) || null,
      });
      res.json({ explanation });
    } catch (error) {
      next(error);
    }
  });

  router.post('/tasks/:id/monitor/explain', async (req, res, next) => {
    try {
      const monitor = await tasks.getMonitor(requireTask(req.params.id).id);
      const explanation = await explainRunHealth({
        ...monitor,
        changedFiles: monitor.changedFiles.slice(0, 30),
        stopReason: monitor.stopReason?.slice(0, 2000) || null,
      });
      res.json({ explanation });
    } catch (error) {
      next(error);
    }
  });

  router.post('/tasks/:id/monitor/ask', async (req, res, next) => {
    try {
      const task = requireTask(req.params.id);
      const question = String(req.body?.question || '').trim();
      if (!question || question.length > 4_000) {
        throw new ApplicationError('INVALID_MONITOR_QUESTION', 'A monitor question between 1 and 4,000 characters is required.', 400);
      }
      const monitor = await tasks.getMonitor(task.id);
      const events = store
        .listEvents(task.id)
        .slice(-100)
        .map((event) => ({
          agent: event.agent,
          type: event.type,
          createdAt: event.createdAt,
          payload: event.payload,
        }));
      const answer = await answerRunQuestion(question, {
        task: { state: task.state, classification: task.classification, models: task.models, error: task.error },
        monitor,
        events,
      });
      res.json({ answer });
    } catch (error) {
      next(error);
    }
  });

  router.get('/tasks/:id/events', (req, res) => {
    requireTask(req.params.id);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      Connection: 'keep-alive',
      'Cache-Control': 'no-cache, no-transform',
    });
    const after = Number(req.headers['last-event-id'] || req.query.after || 0);
    for (const event of store.listEvents(req.params.id, after)) {
      writeEvent(res, event);
    }
    const unsubscribe = tasks.subscribe(req.params.id, (event) => writeEvent(res, event));
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  router.post('/tasks/:id/pause', async (req, res, next) => {
    try {
      res.status(200).json(await tasks.pause(requireTask(req.params.id).id));
    } catch (error) {
      next(error);
    }
  });

  router.post('/tasks/:id/resume', async (req, res, next) => {
    try {
      res.status(202).json(await tasks.resume(requireTask(req.params.id).id));
    } catch (error) {
      next(error);
    }
  });

  router.post('/tasks/:id/cancel', async (req, res, next) => {
    try {
      res.status(200).json(await tasks.cancel(requireTask(req.params.id).id));
    } catch (error) {
      next(error);
    }
  });

  router.post('/tasks/:id/recover', async (req, res, next) => {
    try {
      const task = await tasks.recover(requireTask(req.params.id).id);
      res.status(202).json(task);
    } catch (error) {
      next(error);
    }
  });

  router.post('/tasks/:id/retry', async (req, res, next) => {
    try {
      await tasks.retry(requireTask(req.params.id).id);
      res.status(202).json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post('/tasks/:id/commit-changes', async (req, res, next) => {
    try {
      const task = await tasks.commitUncommittedChanges(requireTask(req.params.id).id);
      res.status(202).json(task);
    } catch (error) {
      next(error);
    }
  });

  router.post('/tasks/:id/retry-push', async (req, res, next) => {
    try {
      const task = requireTask(req.params.id);
      const project = requireProject(task.projectId);
      const result = await pushCurrent(project.root);
      store.updateTask(task.id, {
        pushStatus: result.pushed ? 'pushed' : 'unpushed',
        state: result.pushed ? 'completed' : 'completed_unpushed',
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
