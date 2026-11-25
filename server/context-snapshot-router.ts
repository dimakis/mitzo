import { Router } from 'express';
import { ContextSnapshotRequestSchema, ContextSnapshotResponseSchema } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { ContextSnapshotLifecycle } from './context-snapshot-lifecycle.js';
import { isAuthSessionCurrent, registerAuthSession } from './auth.js';
import { recentAuthorizationSession, requireSameOriginJson } from './operator-http-authority.js';
import { createLogger } from './logger.js';

const log = createLogger('context-snapshot-router');
/** Mount behind operatorAuthMiddleware. Passive GET never collects or acquires a runtime. */
export function createContextSnapshotRouter(
  events: EventStore,
  lifecycle: ContextSnapshotLifecycle,
) {
  const router = Router({ mergeParams: true });
  const visible = (id: string) => {
    const session = events.getSession(id);
    return (
      !!session &&
      !session.isHidden &&
      session.sessionType !== 'symposium' &&
      !session.symposiumConfig
    );
  };
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const auth = recentAuthorizationSession(res);
    if (!auth) return;
    if (!isAuthSessionCurrent(auth))
      return res.status(401).json({ error: 'Operator authorization expired' });
    if (typeof req.params.id !== 'string' || !visible(req.params.id))
      return res.status(404).json({ error: 'Conversation not found' });
    next();
  });
  router.get<{ id: string }>('/', (req, res) => {
    try {
      return res.json(ContextSnapshotResponseSchema.parse(lifecycle.inspect(req.params.id)));
    } catch {
      log.warn('Retained context snapshot unavailable', {
        sessionId: req.params.id,
        stage: 'snapshot_read',
        reason: 'storage_failed',
      });
      return res.status(503).json({ error: 'Context snapshot storage unavailable' });
    }
  });
  router.post<{ id: string }>('/refresh', requireSameOriginJson, async (req, res) => {
    const input = ContextSnapshotRequestSchema.safeParse(req.body);
    if (!input.success) return res.status(400).json({ error: 'Invalid context snapshot request' });
    if (req.get('X-Mitzo-Context-Intent') !== `refresh-${input.data.detail}`)
      return res.status(403).json({ error: 'Explicit context inspection intent required' });
    const auth = recentAuthorizationSession(res);
    if (!auth) return;
    // Revocation expires this login's authority for every waiter on a shared
    // collection. A closed connection only cancels this waiter, so it must not
    // make the shared authority look expired to a sibling that is still connected.
    const revoked = new AbortController();
    const closed = new AbortController();
    const unregister = registerAuthSession(auth, () => revoked.abort());
    const close = () => {
      if (!res.writableEnded) closed.abort();
    };
    res.on('close', close);
    const signal = AbortSignal.any([revoked.signal, closed.signal]);
    const current = () =>
      !revoked.signal.aborted && isAuthSessionCurrent(auth) && visible(req.params.id);
    try {
      const response = await lifecycle.refresh(
        req.params.id,
        input.data,
        {
          key: auth.id,
          current,
          allowTokenCount: async () => current() && input.data.allowTokenCount === true,
        },
        signal,
      );
      if (!isAuthSessionCurrent(auth))
        return res.status(401).json({ error: 'Operator authorization expired' });
      if (!visible(req.params.id)) return res.status(404).json({ error: 'Conversation not found' });
      if (signal.aborted) return;
      return res.json(ContextSnapshotResponseSchema.parse(lifecycle.forDelivery(response)));
    } catch {
      log.warn('Context snapshot response unavailable', {
        sessionId: req.params.id,
        stage: 'snapshot_response',
        reason: 'storage_failed',
      });
      if (!signal.aborted) return res.status(503).json({ error: 'Context snapshot unavailable' });
    } finally {
      unregister();
      res.off('close', close);
    }
  });
  return router;
}
