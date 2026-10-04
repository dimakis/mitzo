import express from 'express';
import { registerAuthSession, type AuthSession } from './auth.js';
import { recentAuthorizationSession } from './connections-router.js';
import { readConnectionsAccess, type ConnectionsAccessSources } from './connections-access.js';

/** Mounted behind operator authentication; no mutation endpoint or credential refresh. */
export function createConnectionsAccessRouter(
  sources: (auth: AuthSession) => ConnectionsAccessSources,
) {
  const router = express.Router();
  router.get('/', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    const auth = recentAuthorizationSession(res);
    if (!auth) return;
    let invalidated = false;
    const unregister = registerAuthSession(auth, () => {
      invalidated = true;
    });
    const forbidden = () =>
      res.status(403).json({ error: 'Operator authorization expired or revoked' });
    try {
      if (invalidated || auth.expiresAt <= Date.now()) return forbidden();
      const inventory = await readConnectionsAccess(sources(auth));
      // A source can finish before another; keep browser authority through the response.
      if (invalidated || auth.expiresAt <= Date.now()) return forbidden();
      return res.json(inventory);
    } finally {
      unregister();
    }
  });
  return router;
}
