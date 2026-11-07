import { Router } from 'express';
import { recentAuthorizationSession } from './connections-router.js';
import {
  CreateSessionCapabilityGrant,
  type SessionCapabilityGrants,
  type SessionCapabilityInventory,
} from './session-capability-grants.js';

/** Interactive operator route only. Internal tool credentials cannot create
 * grants. The custom header forces a browser preflight on cross-origin writes. */
export function createSessionCapabilityRouter(options: {
  grants: SessionCapabilityGrants;
  hasSession(id: string): boolean;
  title?(id: string): string | undefined;
}) {
  const router = Router({ mergeParams: true });
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const auth = recentAuthorizationSession(res);
    if (!auth) return;
    const id = req.params.id;
    if (typeof id !== 'string' || !options.hasSession(id))
      return res.status(404).json({ error: 'Conversation not found' });
    if (req.method !== 'GET' && req.get('X-Mitzo-Access-Intent') !== 'manage-grants')
      return res.status(403).json({ error: 'Use the Access controls to change grants' });
    try {
      options.grants.list(auth.id, id);
    } catch {
      return res.status(409).json({
        error:
          'Live access for this login is unavailable. Reconnect the conversation and refresh Access.',
      });
    }
    next();
  });
  router.get('/', (req, res) => {
    const id = req.params.id as string;
    const auth = recentAuthorizationSession(res);
    if (!auth) return;
    res.json({
      sessionId: id,
      observedAt: Date.now(),
      grants: options.grants.list(auth.id, id),
      sessions: options.grants
        .candidates(auth.id)
        .filter((s) => options.hasSession(s.sessionId))
        .map((s) => ({ ...s, title: options.title?.(s.sessionId) ?? s.sessionId })),
      automaticReview: {
        state: 'unavailable',
        reason:
          'Automatic approval review needs a verified reviewer model, account and billing route. Human review handles remaining requests.',
      },
    } satisfies SessionCapabilityInventory);
  });
  router.post('/', (req, res) => {
    const auth = recentAuthorizationSession(res);
    if (!auth) return;
    const parsed = CreateSessionCapabilityGrant.safeParse(req.body);
    if (
      !parsed.success ||
      !parsed.data.expectedContexts ||
      !parsed.data.sessionIds.includes(req.params.id as string) ||
      parsed.data.sessionIds.some((id) => !options.hasSession(id))
    )
      return res.status(400).json({
        error:
          'Select this conversation, the capability, duration and any other visible conversations explicitly',
      });
    try {
      return res.status(201).json(options.grants.create(auth.id, parsed.data));
    } catch {
      return res.status(409).json({
        error:
          'Access changed or a selected folder is protected. Refresh Access and check the selected conversations and folders.',
      });
    }
  });
  router.delete('/:grantId', async (req, res) => {
    const auth = recentAuthorizationSession(res);
    if (!auth) return;
    try {
      await options.grants.revoke(auth.id, req.params.id as string, req.params.grantId as string);
      return res.sendStatus(204);
    } catch {
      return res.status(409).json({
        error:
          'Grant revoked or unavailable. Refresh Access; a running command may need to be stopped.',
      });
    }
  });
  return router;
}
