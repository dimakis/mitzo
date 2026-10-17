import { Router } from 'express';
import { z } from 'zod';
import { isAuthSessionCurrent, registerAuthSession, type AuthSession } from './auth.js';
import { custodianRequestSignal } from './symposium-custodian-authority.js';
import { requireSameOriginJson } from './connections-router.js';
import type { ToolBuilderRecord, ToolBuilderStore } from './tool-builder-store.js';

const owner = 'user'; // Existing stable interactive operator subject, not a login JTI.
const digest = z.strictObject({ contractDigest: z.string().regex(/^[a-f0-9]{64}$/) });
const identity = z.strictObject({ id: z.uuid(), version: z.coerce.number().int().positive() });
function summary(record: ToolBuilderRecord) {
  const { draft, status, review, sessionId } = record;
  return {
    id: draft.id,
    version: draft.version,
    name: draft.name,
    description: draft.description,
    status,
    sessionId,
    contractDigest: draft.contractDigest,
    sourceDigest: draft.sourceDigest,
    tests: draft.tests.summary,
    review,
  };
}

/** The builder has no tool or network capability that can invoke these operator actions. */
export function createToolBuilderRouter(current: () => ToolBuilderStore | undefined) {
  const router = Router();
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const auth = res.locals.authSession as AuthSession | undefined;
    if (!auth || !isAuthSessionCurrent(auth))
      return res.status(403).json({ error: 'Interactive operator authentication is required' });
    next();
  });
  const store = () => {
    const selected = current();
    if (!selected) throw Error('Tool Builder review is unavailable on this runtime');
    return selected;
  };
  router.get('/', (req, res) => {
    try {
      const query = z
        .strictObject({
          sessionId: z.string().min(1).max(128).optional(),
          offset: z.coerce.number().int().nonnegative().default(0),
        })
        .parse(req.query);
      const selected = store();
      const drafts = selected.list(owner, query.sessionId, query.offset);
      res.json({
        drafts: drafts.map(summary),
        nextOffset: drafts.length === 20 ? query.offset + 20 : null,
      });
    } catch {
      res
        .status(400)
        .json({ error: 'Tool Builder drafts are unavailable. Check this runtime and reload.' });
    }
  });
  router.get('/drafts/:id/:version', (req, res) => {
    try {
      const { id, version } = identity.parse(req.params);
      const record = store().read(owner, id, version);
      if (!record) return res.status(404).json({ error: 'Tool draft version was not found' });
      res.json(record);
    } catch {
      res.status(400).json({ error: 'Tool draft version is unavailable' });
    }
  });
  router.post('/drafts/:id/:version/review', requireSameOriginJson, (req, res) => {
    try {
      const { id, version } = identity.parse(req.params);
      const body = digest
        .extend({ decision: z.enum(['accepted', 'rejected']), feedback: z.string().max(4000) })
        .parse(req.body);
      res.json(store().review(owner, id, version, body, owner));
    } catch {
      res.status(400).json({
        error: 'Review requires the exact submitted version and contract. Reload before deciding.',
      });
    }
  });
  router.post('/drafts/:id/:version/publish', requireSameOriginJson, async (req, res) => {
    const auth = res.locals.authSession as AuthSession;
    const controller = new AbortController();
    const unregister = registerAuthSession(auth, () => controller.abort());
    const inherited = custodianRequestSignal(req);
    const signal = AbortSignal.any([controller.signal, ...(inherited ? [inherited] : [])]);
    const close = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', close);
    try {
      const { id, version } = identity.parse(req.params);
      const body = digest.parse(req.body);
      const selected = store();
      const assertCurrent = () => {
        signal.throwIfAborted();
        if (!isAuthSessionCurrent(auth) || current() !== selected)
          throw Error('Tool publication authority changed');
      };
      const receipt = await selected.publish(owner, id, version, body.contractDigest, {
        signal,
        assertCurrent,
      });
      assertCurrent();
      res.json(receipt);
    } catch {
      if (!res.destroyed)
        res.status(400).json({
          error:
            'Publication requires operator acceptance and the exact implementation installed and qualified from reviewed source on a supported runtime.',
        });
    } finally {
      unregister();
      res.off('close', close);
    }
  });
  router.post('/drafts/:id/:version/cancel', requireSameOriginJson, (req, res) => {
    try {
      const { id, version } = identity.parse(req.params);
      z.strictObject({}).parse(req.body);
      res.json(store().cancel(owner, id, version));
    } catch {
      res.status(400).json({ error: 'Only an unpublished draft version can be cancelled' });
    }
  });
  return router;
}
