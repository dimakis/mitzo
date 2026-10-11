import { Router } from 'express';
import { operatorAuthMiddleware, registerAuthSession, type AuthSession } from './auth.js';
import type { PersonalConnection } from './symposium-personal-connections.js';
import {
  createPersonalRoutingDiagnosticHandler,
  type PersonalRoutingDiagnosticOperation,
} from './symposium-routing-diagnostic-route.js';

/** Host-owned capabilities; the router owns no credentials, providers or stores. */
export interface SymposiumPersonalConnectionService {
  list(): PersonalConnection[];
  create(label: string): PersonalConnection;
  disconnect(id: string, revision: number): Promise<PersonalConnection>;
  recoverDiscovery?(id: string, revision: number, assertOperator: () => void): Promise<unknown>;
  discoverModels?(id: string, revision: number, assertOperator: () => void): Promise<unknown>;
  diagnoseRouting?: PersonalRoutingDiagnosticOperation;
}

/** Authenticate matched operations only, preserving application fallback/OPTIONS
 * behavior. Resolve the installed host per request; composition owns installation. */
export function createSymposiumPersonalConnectionRouter(
  resolveService: () => SymposiumPersonalConnectionService | undefined,
): Router {
  const router = Router();
  router.get('/', operatorAuthMiddleware, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const service = resolveService();
    if (!service) {
      res.status(503).json({ error: 'Personal connections are unavailable.' });
      return;
    }
    res.json({ connections: service.list() });
  });
  router.post('/', operatorAuthMiddleware, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const service = resolveService();
    if (!service) {
      res.status(503).json({ error: 'Personal connections are unavailable.' });
      return;
    }
    try {
      if (typeof req.body?.label !== 'string') throw new Error();
      res.status(201).json(service.create(req.body.label));
    } catch {
      res.status(400).json({
        error:
          'Use a unique slot and a label of 1–120 characters; at most 100 slots are supported.',
      });
    }
  });
  router.post('/:id/disconnect', operatorAuthMiddleware, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const service = resolveService();
    if (!service) {
      res.status(503).json({ error: 'Personal connections are unavailable.' });
      return;
    }
    if (!Number.isSafeInteger(req.body?.expectedRevision) || req.body.expectedRevision < 1) {
      res.status(400).json({ error: 'A current connection revision is required.' });
      return;
    }
    try {
      res.json(await service.disconnect(String(req.params.id), req.body.expectedRevision));
    } catch {
      res.status(409).json({
        error:
          'Connection changed or credential cleanup is unconfirmed. Refresh connection status; host recovery may be required.',
      });
    }
  });
  router.post(
    ['/:id/models/refresh', '/:id/models/recover'],
    operatorAuthMiddleware,
    async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const discover = req.path.endsWith('/recover')
        ? resolveService()?.recoverDiscovery
        : resolveService()?.discoverModels;
      if (!discover) {
        res.status(503).json({ error: 'Owned personal model discovery is unavailable.' });
        return;
      }
      if (!Number.isSafeInteger(req.body?.expectedRevision) || req.body.expectedRevision < 1) {
        res.status(400).json({ error: 'A current connection revision is required.' });
        return;
      }
      const session = res.locals.authSession as AuthSession;
      let current = true;
      const unregister = registerAuthSession(session, () => {
        current = false;
      });
      const assertOperator = () => {
        if (!current || session.expiresAt <= Date.now())
          throw new Error('Operator session expired');
      };
      try {
        assertOperator();
        const result = await discover(
          String(req.params.id),
          req.body.expectedRevision,
          assertOperator,
        );
        assertOperator();
        const status = (result as { status?: unknown })?.status;
        res
          .status(status === 'failed' ? 422 : status === 'reconciliation_required' ? 409 : 200)
          .json(result);
      } catch {
        res.status(409).json({
          error:
            'Discovery is unavailable or requires recovery. Refresh connection status before retry.',
        });
      } finally {
        unregister();
      }
    },
  );
  router.post(
    '/:id/routing-diagnostic',
    operatorAuthMiddleware,
    createPersonalRoutingDiagnosticHandler(() => resolveService()?.diagnoseRouting),
  );
  return router;
}
