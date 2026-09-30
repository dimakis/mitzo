import { Router } from 'express';
import { z } from 'zod';
import { SymposiumProfileProposalStore } from './symposium-profile-proposals.js';

const Id = z.string().trim().min(1).max(128);
const SaveBody = z.strictObject({
  sessionId: Id,
  profileId: Id,
  expectedRevision: z.number().int().nonnegative(),
  definition: z.unknown(),
});
const DiscardBody = z.strictObject({ sessionId: Id });

/** Interactive actions only. The model-facing tool cannot use this router. */
export function createSymposiumProfileProposalRouter(
  store: SymposiumProfileProposalStore,
  sessionExists: (sessionId: string) => boolean,
): Router {
  const router = Router();
  router.use((_req, res, next) => {
    if (!res.locals.authSession)
      return res.status(403).json({ error: 'Interactive operator authentication is required' });
    next();
  });
  router.get('/', (req, res) => {
    const parsed = Id.safeParse(req.query.sessionId);
    if (!parsed.success) return res.status(400).json({ error: 'Session ID is required' });
    if (!sessionExists(parsed.data)) return res.status(404).json({ error: 'Session not found' });
    try {
      res.json(store.listPending('user', parsed.data));
    } catch (error) {
      res
        .status(400)
        .json({ error: error instanceof Error ? error.message : 'Proposal unavailable' });
    }
  });
  router.post('/:proposalId/save', (req, res) => {
    const parsed = SaveBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid profile proposal save' });
    if (!sessionExists(parsed.data.sessionId))
      return res.status(404).json({ error: 'Session not found' });
    try {
      const { sessionId, ...save } = parsed.data;
      res.json(store.save('user', sessionId, req.params.proposalId, save));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Proposal save failed';
      res
        .status(/not found/i.test(message) ? 404 : /conflict|discarded/i.test(message) ? 409 : 400)
        .json({ error: message });
    }
  });
  router.post('/:proposalId/discard', (req, res) => {
    const parsed = DiscardBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid proposal discard' });
    if (!sessionExists(parsed.data.sessionId))
      return res.status(404).json({ error: 'Session not found' });
    try {
      res.json(store.discard('user', parsed.data.sessionId, req.params.proposalId));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Proposal discard failed';
      res.status(/not found/i.test(message) ? 404 : 409).json({ error: message });
    }
  });
  return router;
}
