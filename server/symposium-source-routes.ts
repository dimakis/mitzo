import { sourceImportPublicError } from './symposium-source-errors.js';
import { Router } from 'express';
import { z } from 'zod';
import { registerAuthSession, type AuthSession } from './auth.js';
import {
  requireSameOriginJson,
  requireRecentConnectionAuthorization,
} from './connections-router.js';
import { inspectLocalSource, exportLocalSource } from './symposium-source-git.js';
import type { SymposiumSourceHost } from './symposium-source-service.js';
import type { EventStore } from './event-store.js';
const selection = z.strictObject({
  repositoryId: z.string().min(1).max(128),
  targetRepository: z.string().min(3).max(200),
  baseBranch: z.string().min(1).max(201),
  featureBranch: z.string().min(1).max(201),
});
const plan = selection.extend({
  baseOid: z.string().regex(/^[a-f0-9]{40}$/),
  treeOid: z.string().regex(/^[a-f0-9]{40}$/),
  sourceIdentity: z.string().regex(/^[a-f0-9]{64}$/),
  historyCommits: z.number().int().min(1).max(10000),
});
export function createSymposiumSourceRouter(deps: {
  repositories(): Record<string, string>;
  getSession: EventStore['getSession'];
  getHost(): SymposiumSourceHost | undefined;
}) {
  const router = Router({ mergeParams: true });
  const session = (id: string) => {
    const value = deps.getSession(id);
    if (value?.sessionType !== 'symposium' || !value.symposiumConfig)
      throw Error('Symposium session unavailable');
    return JSON.parse(value.symposiumConfig) as { revision: number };
  };
  router.get('/', (req, res) => {
    try {
      const config = session((req.params as { id: string }).id);
      res.json({
        repositories: Object.keys(deps.repositories()),
        expectedRevision: config.revision,
        artifact: deps.getHost()?.status((req.params as { id: string }).id) ?? {
          available: false,
          state: 'unavailable',
        },
      });
    } catch {
      res.status(409).json({ error: 'Source materialization unavailable' });
    }
  });
  router.post('/preview', requireSameOriginJson, async (req, res) => {
    const parsed = selection.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'Select a configured repository, target, base and feature branch' });
      return;
    }
    try {
      const id = (req.params as { id: string }).id;
      const config = session(id);
      const state = deps.getHost()?.status(id);
      if (!state?.available)
        throw Error('Source import requires an unused initialized artifact volume');
      const source = await inspectLocalSource(deps.repositories(), parsed.data);
      res.json({
        plan: source,
        expectedRevision: config.revision,
        expectedGeneration: state.volumeGeneration,
        disclosure:
          'All committed history reachable from this local base is imported. No remote fetch has verified the current GitHub head. Working tree, untracked files and host credentials are excluded.',
      });
    } catch (error) {
      res.status(409).json({ error: sourceImportPublicError(error) });
    }
  });
  router.post('/import', requireSameOriginJson, async (req, res) => {
    if (!requireRecentConnectionAuthorization(res, req.header('x-csrf-token') ?? '')) return;
    const parsed = z
      .strictObject({
        plan,
        expectedRevision: z.number().int().positive(),
        expectedGeneration: z.string().min(1).max(128),
        operationId: z.string().min(1).max(200),
        confirmation: z.literal('IMPORT COMMITTED REPOSITORY HISTORY'),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'Exact source preview and typed history import approval required' });
      return;
    }
    const auth = res.locals.authSession as AuthSession;
    let invalidated = false;
    const unregister = registerAuthSession(auth, () => {
      invalidated = true;
    });
    const authorize = () => {
      if (invalidated) {
        res.status(401).json({ error: 'App authentication expired or revoked' });
        throw Error('Authorization invalidated');
      }
      if (!requireRecentConnectionAuthorization(res, req.header('x-csrf-token') ?? ''))
        throw Error('Recent reauthorization required');
    };
    try {
      const id = (req.params as { id: string }).id;
      const host = deps.getHost();
      if (!host) throw Error('Owned source import capability unavailable');
      if (session(id).revision !== parsed.data.expectedRevision)
        throw Error('Source session revision changed');
      const state = host.status(id);
      if (!state.available || state.volumeGeneration !== parsed.data.expectedGeneration)
        throw Error('Source import is unavailable or artifact generation changed');
      const exported = await exportLocalSource(deps.repositories(), parsed.data.plan);
      authorize();
      res.json(
        await host.import(
          {
            sessionId: id,
            expectedRevision: parsed.data.expectedRevision,
            expectedGeneration: parsed.data.expectedGeneration,
            operationId: parsed.data.operationId,
            actor: `operator:${auth.id}`,
            ...exported,
          },
          authorize,
        ),
      );
    } catch (error) {
      if (!res.headersSent) res.status(409).json({ error: sourceImportPublicError(error) });
    } finally {
      unregister();
    }
  });
  return router;
}
