import { Router } from 'express';
import { z } from 'zod';
import { NotificationFilter, NotificationPreferences } from '@mitzo/protocol';
import type { NotificationCenter } from './notification-center.js';
import { operatorAuthMiddleware } from './auth.js';
import { getPendingSessionId, hasPending, resolvePending } from './permissions.js';
const responseBody = z
  .object({
    sessionId: z.string().min(1),
    decision: z.enum(['once', 'deny']),
    answers: z.record(z.string(), z.array(z.string().max(4000)).max(9)).optional(),
  })
  .strict();
export function notificationRouter(center: NotificationCenter): Router {
  const router = Router();
  router.use(operatorAuthMiddleware);
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.get('/', (req, res) => {
    const query = z
      .object({
        filter: NotificationFilter.default('all'),
        limit: z.coerce.number().int().min(1).max(100).default(100),
        offset: z.coerce.number().int().min(0).max(100000).default(0),
      })
      .safeParse(req.query);
    if (!query.success) return res.status(400).json({ error: 'Invalid notification filter' });
    res.json(center.feed(query.data.filter, query.data.limit, query.data.offset));
  });
  router.put('/preferences', (req, res) => {
    const parsed = NotificationPreferences.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid notification preferences' });
    const preferences = center.store.setPreferences(parsed.data);
    center.changed();
    res.json(preferences);
  });
  router.post('/read-updates', (_req, res) => {
    center.store.markUpdatesRead();
    center.changed();
    res.json({ ok: true });
  });
  router.post('/test', (_req, res) => res.status(202).json({ id: center.test() }));
  router.post('/:id/read', (req, res) => {
    if (!center.store.markRead(req.params.id))
      return res.status(404).json({ error: 'Notification not found' });
    center.changed();
    res.json({ ok: true });
  });
  router.post('/:id/respond', (req, res) => {
    const parsed = responseBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid response' });
    center.feed('needs');
    const item = center.store.get(req.params.id);
    if (
      !item?.permId ||
      item.resolvedAt !== null ||
      item.sessionId !== parsed.data.sessionId ||
      !hasPending(item.permId) ||
      getPendingSessionId(item.permId) !== item.sessionId
    )
      return res
        .status(409)
        .json({ error: 'This request expired or was already resolved. Refresh notifications.' });
    if (!resolvePending(item.permId, parsed.data.decision, parsed.data.answers, item.sessionId))
      return res.status(400).json({ error: 'Complete all questions before responding.' });
    res.json({ ok: true });
  });
  return router;
}
