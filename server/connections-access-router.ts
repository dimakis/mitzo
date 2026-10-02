import express from 'express';
import { recentAuthorizationSession } from './connections-router.js';
import { readConnectionsAccess, type ConnectionsAccessSources } from './connections-access.js';

/** Mounted behind operator authentication; no mutation endpoint or credential refresh. */
export function createConnectionsAccessRouter(sources: () => ConnectionsAccessSources) {
  const router = express.Router();
  router.get('/', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!recentAuthorizationSession(res)) return;
    return res.json(await readConnectionsAccess(sources()));
  });
  return router;
}
