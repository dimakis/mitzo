import express from 'express';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { OpenShellWarmPool } from './openshell-warm-pool.js';
export interface SandboxConversation {
  physicalId?: string | null;
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
  ownershipReview?(physicalId: string, signal: AbortSignal): Promise<unknown>;
  physicalInventory?(signal: AbortSignal): Promise<unknown>;
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
      const signal = AbortSignal.timeout(8000);
      const [snapshot, physicalInventory] = await Promise.all([
        pool.observe(signal),
        deps.physicalInventory?.(signal).catch(() => ({
          available: false,
          error: 'Gateway inventory is unavailable. The physical sandbox count is unknown.',
        })),
      ]);
      res.json({
        ...snapshot,
        physicalInventory,
        conversations: deps.conversations(),
      });
    } catch {
      res
        .status(503)
        .json({ error: 'Could not observe sandbox inventory. Existing resources are retained.' });
    }
  });
  router.get('/:physicalId/ownership', async (req, res) => {
    try {
      if (!deps.ownershipReview)
        return void res
          .status(503)
          .json({ error: 'Ownership review is unavailable. Existing resources are retained.' });
      res.json(await deps.ownershipReview(req.params.physicalId, AbortSignal.timeout(8000)));
    } catch {
      res.status(409).json({
        error:
          'Ownership could not be verified. Refresh inventory; existing resources are retained.',
      });
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
      res.status(e instanceof z.ZodError ? 400 : 409).json({
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
