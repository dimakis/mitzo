import express from 'express';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { OpenShellWarmPool } from './openshell-warm-pool.js';
export interface SandboxConversation {
  conversationId: string;
  sandboxName: string;
  state: string;
  account: string;
  title: string;
  canReviewCleanup: boolean;
}
export function createWarmPoolRouter(deps: {
  pool(): OpenShellWarmPool | null;
  authorize: RequestHandler;
  conversations(): SandboxConversation[];
}) {
  const router = express.Router();
  router.use(deps.authorize);
  router.get('/', async (_req, res) => {
    const pool = deps.pool();
    if (!pool) {
      res.status(503).json({ error: 'Sandbox management is unavailable on this host.' });
      return;
    }
    try {
      res.json({
        ...(await pool.observe(AbortSignal.timeout(8000))),
        conversations: deps.conversations(),
      });
    } catch {
      res
        .status(503)
        .json({ error: 'Could not observe sandbox inventory. Existing resources are retained.' });
    }
  });
  router.post('/', async (req, res) => {
    const pool = deps.pool();
    if (!pool) {
      res.status(503).json({ error: 'Sandbox management is unavailable on this host.' });
      return;
    }
    try {
      const result = await pool.mutate(
        req.body,
        AbortSignal.timeout(120000),
        res.locals.authSession.id,
      );
      res.json({ ...result, conversations: deps.conversations() });
    } catch (e) {
      res
        .status(e instanceof z.ZodError ? 400 : 409)
        .json({
          error:
            e instanceof z.ZodError
              ? 'Invalid sandbox settings or operation.'
              : e instanceof Error
                ? e.message
                : 'Sandbox operation outcome unknown. Refresh before retrying.',
          snapshot: pool.snapshot(),
        });
    }
  });
  return router;
}
