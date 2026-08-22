import { Router } from 'express';
import type { Store } from '../../db.js';
import { CredentialVault } from '../../infrastructure/security/vault.js';
import { JulesApiClient } from '../../providers/jules/client.js';
import {
  getJulesCredentialStatus,
  resolveJulesApiKey,
  validateJulesApiKey,
} from '../../providers/jules/credentials.js';
import { discoverJulesSource } from '../../providers/jules/source-discovery.js';
import { JulesSessionManager } from '../../providers/jules/session-manager.js';
import { runWorktreeReview } from '../../providers/jules/worktree-review.js';
import { runCodexReviewForJules } from '../../providers/jules/codex-review.js';

// ============================================================================
// Google Jules Cloud Execution API Routes & Route Controller (Phase 16)
// ============================================================================

export interface JulesRouterOptions {
  store?: Store;
  vault?: CredentialVault;
  sessionManager?: JulesSessionManager;
  julesClient?: JulesApiClient;
}

export function createJulesRouter(
  storeOrOptions?: Store | JulesRouterOptions,
  explicitVault?: CredentialVault
): Router {
  const router = Router();

  let store: Store | undefined;
  let vault: CredentialVault;
  let sessionManager: JulesSessionManager | undefined;
  let customClient: JulesApiClient | undefined;

  if (storeOrOptions && 'manager' in storeOrOptions) {
    store = storeOrOptions as Store;
    vault = explicitVault ?? new CredentialVault();
    sessionManager = new JulesSessionManager(store, vault);
  } else if (storeOrOptions) {
    const opts = storeOrOptions as JulesRouterOptions;
    store = opts.store;
    vault = opts.vault ?? explicitVault ?? new CredentialVault();
    customClient = opts.julesClient;
    sessionManager = opts.sessionManager ?? (store ? new JulesSessionManager(store, vault) : undefined);
  } else {
    vault = explicitVault ?? new CredentialVault();
  }

  function resolveClient(): JulesApiClient {
    if (customClient) return customClient;
    const { apiKey } = resolveJulesApiKey(vault);
    if (!apiKey) {
      throw new Error('Jules API key is not configured.');
    }
    return new JulesApiClient({ apiKey, timeoutMs: 15_000 });
  }

  function requireStore(): Store {
    if (!store) throw new Error('Database store is not available.');
    return store;
  }

  function requireSessionManager(): JulesSessionManager {
    if (!sessionManager) {
      const s = requireStore();
      sessionManager = new JulesSessionManager(s, vault);
    }
    return sessionManager;
  }

  // 1. Credentials Status
  router.get('/jules/credential-status', (_req, res) => {
    res.json(getJulesCredentialStatus(vault));
  });

  // 2. Validate Key
  router.post('/jules/validate-key', async (req, res, next) => {
    try {
      let keyToTest = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
      if (!keyToTest) {
        const current = resolveJulesApiKey(vault);
        keyToTest = current.apiKey || '';
      }

      if (!keyToTest) {
        res.status(400).json({ valid: false, error: 'No Jules API key provided or configured.' });
        return;
      }

      const result = await validateJulesApiKey(keyToTest);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // 3. Save Key
  router.post('/jules/save-key', async (req, res, next) => {
    try {
      const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
      if (!apiKey) {
        res.status(400).json({ error: 'API key cannot be empty.' });
        return;
      }

      const validate = Boolean(req.body?.validate ?? true);
      if (validate) {
        const validation = await validateJulesApiKey(apiKey);
        if (!validation.valid) {
          res.status(400).json({ error: `Invalid Jules API key: ${validation.error || 'Failed to authenticate.'}` });
          return;
        }
      }

      vault.setSecret('jules_api_key', apiKey);
      res.json({
        ok: true,
        status: getJulesCredentialStatus(vault),
      });
    } catch (error) {
      next(error);
    }
  });

  // 4. Clear Key
  router.delete('/jules/clear-key', (_req, res) => {
    vault.removeSecret('jules_api_key');
    res.json({
      ok: true,
      status: getJulesCredentialStatus(vault),
    });
  });

  // 5. Project Source Discovery
  router.get('/projects/:id/jules-source', async (req, res, next) => {
    try {
      const s = requireStore();
      const project = s.getProject(req.params.id);
      if (!project) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }

      const result = await discoverJulesSource(project.root, {
        vault,
        julesClient: customClient,
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // 6. Explicit Cloud Dispatch
  router.post('/projects/:id/jules/dispatch', async (req, res, next) => {
    try {
      const s = requireStore();
      const sm = requireSessionManager();
      const project = s.getProject(req.params.id);
      if (!project) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }

      const prompt = String(req.body?.prompt || '').trim();
      if (!prompt) {
        res.status(400).json({ error: 'Task prompt is required.' });
        return;
      }

      let sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
      if (!sessionId) {
        const session = s.createSession(project.id, prompt.slice(0, 40));
        sessionId = session.id;
      }

      const task = s.createTask(project.id, sessionId, prompt, null, null, 'cloud');

      const dispatchResult = await sm.dispatchSession(task.id, prompt, {
        projectRoot: project.root,
        requirePlanApproval: Boolean(req.body?.requirePlanApproval ?? true),
        autoPr: Boolean(req.body?.autoPr ?? true),
        vault,
        julesClient: customClient,
      });

      if (!dispatchResult.ok) {
        res.status(400).json({
          ok: false,
          taskId: task.id,
          error: dispatchResult.error,
          resolution: dispatchResult.resolution,
        });
        return;
      }

      res.status(201).json({
        ok: true,
        taskId: task.id,
        sessionId,
        remoteSessionId: dispatchResult.cloudSession?.remoteSessionId,
        cloudSession: dispatchResult.cloudSession,
      });
    } catch (error) {
      next(error);
    }
  });

  // 7. Get Task Cloud Session
  router.get('/tasks/:id/jules-session', (req, res, next) => {
    try {
      const s = requireStore();
      const task = s.getTask(req.params.id);
      if (!task) {
        res.status(404).json({ error: 'Task not found.' });
        return;
      }

      const cloudSession = s.manager.cloudSessions.getByTaskId(task.id);
      res.json({
        task,
        cloudSession,
      });
    } catch (error) {
      next(error);
    }
  });

  // 8. Approve Plan
  router.post('/tasks/:id/jules/approve-plan', async (req, res, next) => {
    try {
      const s = requireStore();
      const task = s.getTask(req.params.id);
      if (!task) {
        res.status(404).json({ error: 'Task not found.' });
        return;
      }

      const cloudSession = s.manager.cloudSessions.getByTaskId(task.id);
      if (!cloudSession) {
        res.status(404).json({ error: 'Cloud session not found for task.' });
        return;
      }

      const client = resolveClient();
      await client.approvePlan(cloudSession.sessionResourceName);

      s.addEvent(task.id, 'orchestra', 'cloud.plan_approved', {
        remoteSessionId: cloudSession.remoteSessionId,
      });

      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  // 9. Send Message to Jules Cloud Session
  const handleSendMessage = async (req: any, res: any, next: any) => {
    try {
      const s = requireStore();
      const task = s.getTask(req.params.id);
      if (!task) {
        res.status(404).json({ error: 'Task not found.' });
        return;
      }

      const cloudSession = s.manager.cloudSessions.getByTaskId(task.id);
      if (!cloudSession) {
        res.status(404).json({ error: 'Cloud session not found for task.' });
        return;
      }

      const prompt = String(req.body?.prompt || req.body?.message || '').trim();
      if (!prompt) {
        res.status(400).json({ error: 'Message prompt cannot be empty.' });
        return;
      }

      const client = resolveClient();
      await client.sendMessage(cloudSession.sessionResourceName, prompt);

      s.addEvent(task.id, 'orchestra', 'cloud.feedback_sent', {
        remoteSessionId: cloudSession.remoteSessionId,
        prompt,
      });

      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  };

  router.post('/tasks/:id/jules/message', handleSendMessage);
  router.post('/tasks/:id/jules/feedback', handleSendMessage);

  // 10. Cancel / Delete Cloud Session
  router.post('/tasks/:id/jules/cancel', async (req, res, next) => {
    try {
      const s = requireStore();
      const sm = requireSessionManager();
      const task = s.getTask(req.params.id);
      if (!task) {
        res.status(404).json({ error: 'Task not found.' });
        return;
      }

      const cloudSession = s.manager.cloudSessions.getByTaskId(task.id);
      if (!cloudSession) {
        res.status(404).json({ error: 'Cloud session not found for task.' });
        return;
      }

      const result = await sm.cancelSession(cloudSession.remoteSessionId, { julesClient: customClient });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.delete('/tasks/:id/jules-session', async (req, res, next) => {
    try {
      const s = requireStore();
      const sm = requireSessionManager();
      const task = s.getTask(req.params.id);
      if (!task) {
        res.status(404).json({ error: 'Task not found.' });
        return;
      }

      const cloudSession = s.manager.cloudSessions.getByTaskId(task.id);
      if (!cloudSession) {
        res.status(404).json({ error: 'Cloud session not found for task.' });
        return;
      }

      const result = await sm.cancelSession(cloudSession.remoteSessionId, { julesClient: customClient });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // 11. List Activities (with pagination)
  router.get('/tasks/:id/jules/activities', async (req, res, next) => {
    try {
      const s = requireStore();
      const task = s.getTask(req.params.id);
      if (!task) {
        res.status(404).json({ error: 'Task not found.' });
        return;
      }

      const cloudSession = s.manager.cloudSessions.getByTaskId(task.id);
      if (!cloudSession) {
        res.status(404).json({ error: 'Cloud session not found for task.' });
        return;
      }

      const client = resolveClient();
      const pageToken = typeof req.query?.pageToken === 'string' ? req.query.pageToken : undefined;
      const pageSize = req.query?.pageSize ? parseInt(String(req.query.pageSize), 10) : undefined;
      const response = await client.listActivities(cloudSession.sessionResourceName, pageSize, pageToken);
      res.json({ activities: response.activities, nextPageToken: response.nextPageToken });
    } catch (error) {
      next(error);
    }
  });

  // 12. Import PR & Review (Feature-gated until Phase 19)
  router.post('/tasks/:id/jules/import-pr', async (req, res, next) => {
    try {
      if (process.env.ORCHESTRA_ENABLE_EXPERIMENTAL_PR_IMPORT !== 'true') {
        res.status(501).json({
          error: 'PR import and worktree verification are feature-gated until Phase 19.',
          code: 'FEATURE_GATED',
        });
        return;
      }

      const s = requireStore();
      const task = s.getTask(req.params.id);
      if (!task) {
        res.status(404).json({ error: 'Task not found.' });
        return;
      }

      const project = s.getProject(task.projectId);
      if (!project) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }

      const cloudSession = s.manager.cloudSessions.getByTaskId(task.id);
      const prHeadSha = typeof req.body?.prHeadSha === 'string' ? req.body.prHeadSha : cloudSession?.prHeadSha;
      const baseSha = typeof req.body?.baseSha === 'string' ? req.body.baseSha : cloudSession?.baseSha;

      if (!prHeadSha || !baseSha) {
        res.status(400).json({ error: 'Missing prHeadSha or baseSha for worktree review.' });
        return;
      }

      // Run isolated worktree review
      const reviewResult = await runWorktreeReview({
        taskId: task.id,
        projectRoot: project.root,
        headSha: prHeadSha,
        baseSha,
      });

      // Run independent Codex review
      const codexResult = await runCodexReviewForJules({
        taskId: task.id,
        projectRoot: project.root,
        request: task.prompt,
        baseSha,
        headSha: prHeadSha,
        changedFiles: reviewResult.changedFiles,
        diff: reviewResult.diff,
        verificationResults: reviewResult.verificationResults,
        store: s,
      });

      res.json({
        ok: true,
        worktreeReview: reviewResult,
        codexReview: codexResult,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
