import express from 'express';
import { z } from 'zod';
import type { AuthSession } from './auth.js';
import { requireSameOriginJson } from './connections-router.js';
import { GithubPublishingFields } from './github-publishing-tool.js';
/** Interactive operators use the registered live tool; no model call, fallback
 * account, durable-metadata impersonation or separate approval bypass. */
export function createGithubPublicationOperatorRouter(deps: {
  hasOrdinarySession(id: string): boolean;
  invoke(
    id: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<{ content: string; isError: boolean }>;
}) {
  const router = express.Router({ mergeParams: true });
  router.post(
    '/',
    (req, res, next) => {
      const session = res.locals.authSession as AuthSession | undefined;
      if (!session || session.expiresAt <= Date.now())
        return res.status(401).json({ error: 'Interactive operator authentication required' });
      res.set('Cache-Control', 'no-store');
      next();
    },
    requireSameOriginJson,
    async (req, res) => {
      const id = String(req.params.id);
      if (!deps.hasOrdinarySession(id))
        return res.status(404).json({ error: 'Ordinary live session not found' });
      const input = z.strictObject(GithubPublishingFields).safeParse(req.body);
      if (!input.success) return res.status(400).json({ error: 'Invalid publishing request' });
      const controller = new AbortController();
      const abort = () => controller.abort();
      req.once('aborted', abort);
      const auth = res.locals.authSession as AuthSession;
      const timer = setTimeout(abort, Math.min(120000, Math.max(0, auth.expiresAt - Date.now())));
      try {
        return res.json(await deps.invoke(id, input.data, controller.signal));
      } catch {
        return res.status(409).json({
          error:
            'Live publishing runtime unavailable. Open the existing conversation before requesting publication.',
        });
      } finally {
        clearTimeout(timer);
        req.off('aborted', abort);
      }
    },
  );
  return router;
}
