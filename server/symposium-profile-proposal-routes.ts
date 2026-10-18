import { Router, type Response } from 'express';
import { z, ZodError } from 'zod';
import { AgentTaskProposalInputSchema } from '@mitzo/protocol';
import { AgentTaskError } from './agent-task-store.js';
import { registerAuthSession, type AuthSession } from './auth.js';
import {
  custodianRequestAuthority,
  custodianRequestSignal,
} from './symposium-custodian-authority.js';
import { requireSameOriginJson } from './connections-router.js';
import {
  ProfileProposalInputSchema,
  SymposiumProfileProposalStore,
} from './symposium-profile-proposals.js';

const Id = z.string().trim().min(1).max(128);
const ProfileSaveBody = z.strictObject({
  sessionId: Id,
  profileId: Id,
  expectedRevision: z.number().int().nonnegative(),
  definition: z.unknown(),
});
const ProfileCreateBody = ProfileProposalInputSchema.extend({ sessionId: Id, idempotencyKey: Id });
const TaskSaveBody = AgentTaskProposalInputSchema.extend({
  sessionId: Id,
  kind: z.literal('task'),
});
const TaskCreateBody = TaskSaveBody.extend({ idempotencyKey: Id });
const DiscardBody = z.strictObject({ sessionId: Id, kind: z.literal('task').optional() });
function failure(res: Response, error: unknown) {
  const message = error instanceof Error ? error.message : 'Proposal request failed';
  const status =
    error instanceof AgentTaskError
      ? error.status
      : error instanceof ZodError
        ? 400
        : /not found/i.test(message)
          ? 404
          : /conflict|discarded|saved.*discard/i.test(message)
            ? 409
            : 400;
  res.status(status).json({ error: message });
}
/** Interactive actions only. The model-facing tools create proposals but cannot save them. */
export function createSymposiumProfileProposalRouter(
  store: SymposiumProfileProposalStore,
  sessionExists: (sessionId: string) => boolean,
): Router {
  const router = Router();
  router.use((req, res, next) => {
    const auth = res.locals.authSession as AuthSession | undefined;
    if (!auth || !Number.isFinite(auth.expiresAt) || auth.expiresAt <= Date.now())
      return res.status(403).json({ error: 'Interactive operator authentication is required' });
    let revoked = false;
    const release = registerAuthSession(auth, () => {
      revoked = true;
    });
    res.once('finish', release);
    res.once('close', release);
    res.locals.assertProposalAuthority = () => {
      try {
        custodianRequestSignal(req)?.throwIfAborted();
        custodianRequestAuthority(req);
        if (revoked || auth.expiresAt <= Date.now()) throw Error('Revoked');
      } catch {
        throw new AgentTaskError('Proposal authorization expired, cancelled or revoked', 403);
      }
    };
    next();
  });
  router.use((req, res, next) => {
    if (req.method !== 'GET' && req.body?.kind === 'task')
      return requireSameOriginJson(req, res, next);
    next();
  });
  const act = (res: Response, sessionId: string, work: () => unknown) => {
    try {
      if (!sessionExists(sessionId)) return res.status(404).json({ error: 'Session not found' });
      res.locals.assertProposalAuthority();
      return res.json(work());
    } catch (error) {
      failure(res, error);
    }
  };
  router.post('/', (req, res) => {
    if (req.body?.kind === 'task') {
      const task = TaskCreateBody.safeParse(req.body);
      if (!task.success) return res.status(400).json({ error: 'Invalid task proposal' });
      const { sessionId, idempotencyKey, taskId, expectedRevision, definition } = task.data;
      const input = { taskId, expectedRevision, definition };
      return act(res, sessionId, () => store.proposeTask('user', sessionId, idempotencyKey, input));
    }
    const parsed = ProfileCreateBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid profile proposal' });
    const { sessionId, idempotencyKey, ...input } = parsed.data;
    return act(res, sessionId, () => store.propose('user', sessionId, idempotencyKey, input));
  });
  router.get('/', (req, res) => {
    const parsed = Id.safeParse(req.query.sessionId);
    if (!parsed.success) return res.status(400).json({ error: 'Session ID is required' });
    return act(res, parsed.data, () => [
      ...store.listPending('user', parsed.data),
      ...store.listTaskProposals('user', parsed.data),
    ]);
  });
  router.post('/:proposalId/save', (req, res) => {
    if (req.body?.kind === 'task') {
      const task = TaskSaveBody.safeParse(req.body);
      if (!task.success) return res.status(400).json({ error: 'Invalid task proposal save' });
      const { sessionId, taskId, expectedRevision, definition } = task.data;
      const input = { taskId, expectedRevision, definition };
      return act(res, sessionId, () =>
        store.saveTask('user', sessionId, req.params.proposalId, input),
      );
    }
    const parsed = ProfileSaveBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid profile proposal save' });
    const { sessionId, ...input } = parsed.data;
    return act(res, sessionId, () => store.save('user', sessionId, req.params.proposalId, input));
  });
  router.post('/:proposalId/discard', (req, res) => {
    const parsed = DiscardBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid proposal discard' });
    return act(res, parsed.data.sessionId, () =>
      parsed.data.kind === 'task'
        ? store.discardTask('user', parsed.data.sessionId, req.params.proposalId)
        : store.discard('user', parsed.data.sessionId, req.params.proposalId),
    );
  });
  return router;
}
