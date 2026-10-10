import { Router } from 'express';
import { InboxQuery } from '@mitzo/protocol';
import { operatorAuthMiddleware } from './auth.js';
import type { NotificationCenter } from './notification-center.js';
import { UnifiedInbox } from './unified-inbox.js';

export function unifiedInboxRouter(
  center: NotificationCenter,
  directory: () => string | undefined,
) {
  const router = Router();
  const inbox = new UnifiedInbox(center.store, directory);
  center.setInboxReconciler(() => inbox.reconcile());
  router.use(['/feed', '/records'], operatorAuthMiddleware);
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.get('/feed', (req, res) => {
    const parsed = InboxQuery.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid Inbox filters' });
    center.feed('needs');
    if (inbox.reconcile()) center.changed();
    const feed = center.store.inboxFeed(parsed.data);
    res.json(feed);
  });
  router.get('/records/:id', (req, res) => {
    center.feed('needs');
    const item = inbox.get(req.params.id);
    if (!item) return res.status(404).json({ error: 'Inbox item not found' });
    res.json(item);
  });
  router.post('/records/:id/resolve', (req, res) => {
    const item = inbox.get(req.params.id);
    if (!item?.inbox || !item.inbox.needsAttention)
      return res
        .status(409)
        .json({ error: 'Respond to session requests in their existing review flow.' });
    center.store.resolveInbox(item.id);
    center.changed();
    res.json({ ok: true });
  });
  return router;
}
