import { Router, type Response } from 'express';
import {
  SessionCollaborationIdSchema,
  SessionCollaborationUpdateSchema,
  SessionCollaborationListQuerySchema,
  SessionCollaborationError,
} from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import { recentAuthorizationSession, requireSameOriginJson } from './connections-router.js';

function failure(res: Response, error: unknown) {
  if (error instanceof SessionCollaborationError)
    return res
      .status(error.code === 'not_found' ? 404 : error.code === 'conflict' ? 409 : 400)
      .json({ error: error.message });
  return res
    .status(503)
    .json({ error: 'Collaboration links could not be checked. Refresh before retrying.' });
}
/** Mount behind operator auth. Linking shares no context, grants no access and dispatches no turn. */
export function createSessionCollaborationRouter({ store }: { store: EventStore }) {
  const router = Router();
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (!recentAuthorizationSession(res)) return;
    next();
  });
  router.get('/', (req, res) => {
    const query = SessionCollaborationListQuerySchema.safeParse(req.query);
    if (!query.success) return res.status(400).json({ error: 'Invalid collaboration query' });
    try {
      return res.json(store.listSessionCollaborations(query.data.sessionId, query.data.after));
    } catch (error) {
      return failure(res, error);
    }
  });
  router.get('/:id', (req, res) => {
    const id = SessionCollaborationIdSchema.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: 'Invalid collaboration ID' });
    try {
      const group = store.getSessionCollaboration(id.data);
      if (!group) return res.status(404).json({ error: 'Collaboration not found' });
      const unavailableParticipantSessionIds = group.participantSessionIds.filter((member) => {
        const session = store.getSession(member);
        return (
          !session ||
          session.isHidden ||
          session.sessionType === 'symposium' ||
          !!session.symposiumConfig
        );
      });
      return res.json({ ...group, unavailableParticipantSessionIds });
    } catch (error) {
      return failure(res, error);
    }
  });
  router.put('/:id', requireSameOriginJson, (req, res) => {
    const id = SessionCollaborationIdSchema.safeParse(req.params.id);
    const input = SessionCollaborationUpdateSchema.safeParse(req.body);
    if (!id.success || !input.success)
      return res.status(400).json({ error: 'Invalid collaboration membership' });
    try {
      return res.json(store.setSessionCollaboration(id.data, input.data));
    } catch (error) {
      return failure(res, error);
    }
  });
  return router;
}
