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
  CollaborationJoinReconcileInputSchema,
  CollaborationJoinSchema,
  CollaborationApplicationReviewRequestSchema,
  CollaborationApplicationReviewResultSchema,
  CollaborationBeginSchema,
  CollaborationSourceSetupQuerySchema,
  CollaborationSourceSetupSchema,
  COLLABORATION_EXECUTION_DISABLED,
} from '@mitzo/protocol';
import { z } from 'zod';
import { registerAuthSession, isAuthSessionCurrent } from './auth.js';
import { custodianRequestSignal } from './symposium-custodian-authority.js';
import { captureAgentLibraryAuthorization } from './agent-library-transport.js';
import { liveTransportAuthSessionId } from './transport-auth-ownership.js';
import type { OrdinaryCollaborationJoiningPort } from './collaboration-joining-owner.js';
import type { CollaborationApplicationReview } from './collaboration-application-review.js';
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
  review,
}: {
  store: EventStore;
  joining?: OrdinaryCollaborationJoiningPort;
  /** Lazy construction uses the existing real workspace owner, never caller settings. */
  review?: () => CollaborationApplicationReview;
}) {
  const router = Router();
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (!recentAuthorizationSession(res)) return;
    next();
  });
  /** Observational selection under the existing real interactive source owner. */
  router.get('/source-setup', (req, res) => {
    const query = CollaborationSourceSetupQuerySchema.safeParse(req.query);
    if (!query.success) return res.status(400).json({ error: 'Invalid source setup query' });
    try {
      const auth = recentAuthorizationSession(res)!;
      const operator = captureAgentLibraryAuthorization(query.data.clientId);
      const assertCurrent = () => {
        operator.assertCurrent();
        if (
          !isAuthSessionCurrent(auth) ||
          operator.auth.id !== auth.id ||
          liveTransportAuthSessionId(query.data.clientId) !== auth.id
        )
          throw new CollaborationContractError('execution_unavailable');
      };
      assertCurrent();
      const result = store.collaborationConversation.sourceSetup(query.data.sourceConversationId);
      assertCurrent();
      return res.json(CollaborationSourceSetupSchema.parse(result));
    } catch (error) {
      return failure(res, error);
    }
  });
  /** First Add agent retains relationship identity only. The existing owner
   * arbitrates exact retries and one source enrollment without creating a chat. */
  router.post('/:id/begin', requireSameOriginJson, (req, res) => {
    const id = SessionCollaborationIdSchema.safeParse(req.params.id);
    const input = CollaborationBeginSchema.safeParse(req.body);
    if (!id.success || !input.success)
      return res.status(400).json({ error: 'Invalid collaboration preparation' });
    try {
      return res.json(store.collaborationConversation.begin(id.data, input.data));
    } catch (error) {
      return failure(res, error);
    }
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
  router.post('/:id/reviews', requireSameOriginJson, async (req, res) => {
    const auth = recentAuthorizationSession(res);
    if (!auth) return;
    const id = SessionCollaborationIdSchema.safeParse(req.params.id);
    const input = CollaborationApplicationReviewRequestSchema.safeParse(req.body);
    if (!id.success || !input.success)
      return res.status(400).json({ error: 'Invalid collaboration review' });
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
    const timer = setTimeout(cancel, Math.min(120000, Math.max(0, auth.expiresAt - Date.now())));
    try {
      controller.signal.throwIfAborted();
      if (!store.getSessionCollaboration(id.data))
        throw new CollaborationContractError('not_found');
      if (!review) return unavailable(res);
      const { clientId, ...intent } = input.data;
      const result = await review().review(auth, clientId, id.data, intent, controller.signal);
      controller.signal.throwIfAborted();
      if (!isAuthSessionCurrent(auth)) throw new Error('Authorization unavailable');
      return res.json(CollaborationApplicationReviewResultSchema.parse(result));
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
  });
  const join = async (
    req: Request,
    res: Response,
    operation: 'confirm' | 'recover' | 'reconcile',
  ) => {
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
    const input =
      operation === 'recover'
        ? z.strictObject({}).safeParse(req.body)
        : operation === 'reconcile'
          ? CollaborationJoinReconcileInputSchema.safeParse(req.body)
          : CollaborationJoinInputSchema.safeParse(req.body);
    const joinId = operation !== 'confirm' ? z.uuid().safeParse(req.params.joinId) : undefined;
    if (!input.success || (operation !== 'confirm' && !joinId?.success))
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
        operation === 'recover' && joinId?.success
          ? await joining.recover(auth.id, id.data, joinId.data, controller.signal)
          : operation === 'reconcile' && joinId?.success
            ? await joining.reconcile(auth.id, id.data, joinId.data, input.data, controller.signal)
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
  router.post('/:id/joins', requireSameOriginJson, (req, res) => join(req, res, 'confirm'));
  router.post('/:id/joins/:joinId/recover', requireSameOriginJson, (req, res) =>
    join(req, res, 'recover'),
  );
  router.post('/:id/joins/:joinId/reconcile', requireSameOriginJson, (req, res) =>
    join(req, res, 'reconcile'),
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
