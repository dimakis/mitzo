import express from 'express';
import type { AuthSession } from './auth.js';
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
    return res.json(await readConnectionsAccess(sources(auth)));
  });
  return router;
}
