import { requireSameOriginJson } from './connections-router.js';
import { Router } from 'express';
import { z } from 'zod';
import {
  operatorAuthMiddleware,
  isAuthSessionCurrent,
  hasPersistentRevocationAuthority,
  type AuthSession,
} from './auth.js';
import type { DeploymentCoordinator } from './deployment-coordinator.js';

const Begin = z.strictObject({
  id: z.string().uuid(),
  targetCommit: z.string().regex(/^[a-f0-9]{40}$/),
});
const Identity = z.strictObject({ id: z.string().uuid() });
const Activation = Identity.extend({ activationId: z.string().uuid() });
const Resume = Identity.extend({
  activationId: z.string().uuid().optional(),
  rollback: z.boolean().optional(),
});
/** Internal agent tokens cannot acquire deployment session-control authority. */
export function createDeploymentRouter(coordinator: DeploymentCoordinator) {
  const router = Router();
  router.use(operatorAuthMiddleware);
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    next();
  });
  router.get('/', (_req, res) => {
    res.json({ protocol: 1, active: coordinator.store.active() ?? null });
  });
  for (const action of ['begin', 'pause', 'activate', 'resume', 'cancel'] as const) {
    router.post(`/${action}`, requireSameOriginJson, async (req, res) => {
      const parsed = (
        action === 'begin'
          ? Begin
          : action === 'activate'
            ? Activation
            : action === 'resume'
              ? Resume
              : Identity
      ).safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Exact deployment identity required' });
        return;
      }
      const auth = res.locals.authSession as AuthSession;
      try {
        const result =
          action === 'begin'
            ? coordinator.begin(parsed.data.id, Begin.parse(req.body).targetCommit, auth)
            : action === 'activate'
              ? coordinator.activate(parsed.data.id, auth, Activation.parse(req.body).activationId)
              : action === 'resume'
                ? await coordinator.resume(parsed.data.id, auth, Resume.parse(req.body))
                : await coordinator[action](parsed.data.id, auth);
        if (!hasPersistentRevocationAuthority() || !isAuthSessionCurrent(auth)) {
          res.status(403).json({ error: 'Deployment operator authorization expired or revoked' });
          return;
        }
        res.json({ protocol: 1, operation: result });
      } catch (error) {
        if (!hasPersistentRevocationAuthority() || !isAuthSessionCurrent(auth)) {
          res.status(403).json({ error: 'Deployment operator authorization expired or revoked' });
          return;
        }
        res.status(409).json({
          error: error instanceof Error ? error.message : 'Deployment reconciliation unavailable',
          active: coordinator.store.active() ?? null,
        });
      }
    });
  }
  return router;
}
