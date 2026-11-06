import type { RequestHandler } from 'express';
import type { NotificationCenter } from './notification-center.js';

/** Express 4 needs an explicit rejection boundary. Never serve a partial feed
 * or expose a filesystem exception when current reconciliation is unavailable. */
export function reconcileInbox(center: NotificationCenter): RequestHandler {
  return (_req, res, next) => {
    void center.reconcileAsync().then(
      () => next(),
      () => {
        res.status(503).json({ error: 'Inbox temporarily unavailable' });
      },
    );
  };
}
