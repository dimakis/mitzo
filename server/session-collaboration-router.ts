import { Router, type Request, type Response } from 'express';
import {
  SessionCollaborationIdSchema,
  SessionCollaborationUpdateSchema,
  SessionCollaborationListQuerySchema,
  SessionCollaborationError,
  CollaborationContractError,
  CollaborationPolicyUpdateSchema,
  CollaborationCursorSchema,
  CollaborationJoinInputSchema,
  CollaborationJoinSchema,
  COLLABORATION_EXECUTION_DISABLED,
} from '@mitzo/protocol';
import { z } from 'zod';
import { registerAuthSession, isAuthSessionCurrent } from './auth.js';
import { custodianRequestSignal } from './symposium-custodian-authority.js';
import type { OrdinaryCollaborationJoiningPort } from './collaboration-joining-owner.js';
import type { EventStore } from './event-store.js';
import { recentAuthorizationSession, requireSameOriginJson } from './connections-router.js';

function failure(res: Response, error: unknown) {
  if (error instanceof CollaborationContractError) {
    const status =
      error.code === 'not_found'
        ? 404
        : ['conflict', 'request_conflict'].includes(error.code)
          ? 409
          : error.code === 'execution_unavailable'
            ? 503
            : 422;
    return res.status(status).json({ error: error.message, code: error.code });
  }
  if (error instanceof SessionCollaborationError)
    return res
      .status(error.code === 'not_found' ? 404 : error.code === 'conflict' ? 409 : 400)
      .json({ error: error.message });
  return res
    .status(503)
    .json({ error: 'Collaboration links could not be checked. Refresh before retrying.' });
}
/** Mount behind operator auth. Linking shares no context, grants no access and dispatches no turn. */
export function createSessionCollaborationRouter({
  store,
  joining,
}: {
  store: EventStore;
  joining?: OrdinaryCollaborationJoiningPort;
}) {
  const router = Router();
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (!recentAuthorizationSession(res)) return;
    next();
  });
  router.get('/:id/conversation', (req, res) => {
    const id = SessionCollaborationIdSchema.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: 'Invalid collaboration ID' });
    try {
      return res.json(store.collaborationConversation.view(id.data));
    } catch (error) {
      return failure(res, error);
    }
  });
  router.get('/:id/events', (req, res) => {
    const id = SessionCollaborationIdSchema.safeParse(req.params.id);
    const cursor = CollaborationCursorSchema.safeParse(req.query);
    if (!id.success || !cursor.success)
      return res.status(400).json({ error: 'Invalid collaboration cursor' });
    try {
      return res.json(store.collaborationConversation.events(id.data, cursor.data.after));
    } catch (error) {
      return failure(res, error);
    }
  });
  router.put('/:id/policy', requireSameOriginJson, (req, res) => {
    const id = SessionCollaborationIdSchema.safeParse(req.params.id);
    const input = CollaborationPolicyUpdateSchema.safeParse(req.body);
    if (!id.success || !input.success)
      return res.status(400).json({ error: 'Invalid collaboration policy' });
    try {
      return res.json(store.collaborationConversation.setPolicy(id.data, input.data));
    } catch (error) {
      return failure(res, error);
    }
  });
  for (const kind of ['snapshots', 'joins'] as const) {
    router.get(`/:id/${kind}/:recordId`, (req, res) => {
      const id = SessionCollaborationIdSchema.safeParse(req.params.id);
      const recordId = z.uuid().safeParse(req.params.recordId);
      if (!id.success || !recordId.success)
        return res.status(400).json({ error: 'Invalid collaboration reference' });
      try {
        const record =
          kind === 'snapshots'
            ? store.collaborationConversation.getSnapshot(id.data, recordId.data)
            : store.collaborationConversation.getJoin(id.data, recordId.data);
        return record
          ? res.json(record)
          : res.status(404).json({ error: 'Collaboration record not found', code: 'not_found' });
      } catch (error) {
        return failure(res, error);
      }
    });
  }
  const unavailable = (res: Response) =>
    res.status(503).json({
      code: 'execution_unavailable',
      error: COLLABORATION_EXECUTION_DISABLED.reason,
      execution: COLLABORATION_EXECUTION_DISABLED,
    });
  const join = async (req: Request, res: Response, recovery: boolean) => {
    const auth = recentAuthorizationSession(res);
    if (!auth) return;
    const id = SessionCollaborationIdSchema.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: 'Invalid collaboration join' });
    try {
      if (!store.getSessionCollaboration(id.data))
        throw new CollaborationContractError('not_found');
    } catch (error) {
      return failure(res, error);
    }
    if (!joining) return unavailable(res);
    const input = recovery
      ? z.strictObject({}).safeParse(req.body)
      : CollaborationJoinInputSchema.safeParse(req.body);
    const joinId = recovery ? z.uuid().safeParse(req.params.joinId) : undefined;
    if (!input.success || (recovery && !joinId?.success))
      return res.status(400).json({ error: 'Invalid collaboration join' });
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const unregister = registerAuthSession(auth, cancel);
    const ownerSignal = custodianRequestSignal(req);
    ownerSignal?.addEventListener('abort', cancel, { once: true });
    if (ownerSignal?.aborted || req.aborted) cancel();
    const close = () => {
      if (!res.writableEnded) cancel();
    };
    req.once('aborted', cancel);
    res.once('close', close);
    const timer = setTimeout(cancel, 120000);
    try {
      controller.signal.throwIfAborted();
      const result =
        recovery && joinId?.success
          ? await joining.recover(auth.id, id.data, joinId.data, controller.signal)
          : await joining.confirm(auth.id, id.data, input.data, controller.signal);
      controller.signal.throwIfAborted();
      if (!isAuthSessionCurrent(auth)) throw new Error('Authorization unavailable');
      return res.json(CollaborationJoinSchema.parse(result));
    } catch (error) {
      if (res.destroyed) return;
      if (!isAuthSessionCurrent(auth))
        return res.status(403).json({ error: 'Operator authorization expired or revoked' });
      return failure(res, error);
    } finally {
      clearTimeout(timer);
      unregister();
      ownerSignal?.removeEventListener('abort', cancel);
      req.off('aborted', cancel);
      res.off('close', close);
    }
  };
  router.post('/:id/joins', requireSameOriginJson, (req, res) => join(req, res, false));
  router.post('/:id/joins/:joinId/recover', requireSameOriginJson, (req, res) =>
    join(req, res, true),
  );
  // Source compilation and ordinary delivery still need their application owners.
  for (const operation of ['messages', 'snapshots']) {
    router.post(`/:id/${operation}`, requireSameOriginJson, (req, res) => {
      const id = SessionCollaborationIdSchema.safeParse(req.params.id);
      if (!id.success) return res.status(400).json({ error: 'Invalid collaboration ID' });
      try {
        if (!store.getSessionCollaboration(id.data))
          throw new CollaborationContractError('not_found');
        return res.status(503).json({
          code: 'execution_unavailable',
          error: COLLABORATION_EXECUTION_DISABLED.reason,
          execution: COLLABORATION_EXECUTION_DISABLED,
        });
      } catch (error) {
        return failure(res, error);
      }
    });
  }
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
