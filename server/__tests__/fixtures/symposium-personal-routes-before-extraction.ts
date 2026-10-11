/** Frozen behavior oracle from accepted main 9f997b53, before PR858.
 * Only the application/host holders are injected; retain the original handlers.
 * This fixture is historical test data, not another production implementation. */
import express from 'express';
import cookieParser from 'cookie-parser';
import {
  authMiddleware,
  operatorAuthMiddleware,
  registerAuthSession,
  type AuthSession,
} from '../../auth.js';
import { createPersonalRoutingDiagnosticHandler } from '../../symposium-routing-diagnostic-route.js';
import type { SymposiumPersonalConnectionService } from '../../symposium-personal-connection-router.js';

export function personalConnectionRoutesBeforeExtraction(
  service: SymposiumPersonalConnectionService | undefined,
) {
  const app = express();
  app.set('env', 'production');
  app.use(express.json(), cookieParser(), authMiddleware);
  let symposiumProductionHost: { personalConnections: typeof service } | undefined = {
    personalConnections: service,
  };
  app.get('/api/symposium/personal/connections', operatorAuthMiddleware, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const service = symposiumProductionHost?.personalConnections;
    if (!service) {
      res.status(503).json({ error: 'Personal connections are unavailable.' });
      return;
    }
    res.json({ connections: service.list() });
  });
  app.post('/api/symposium/personal/connections', operatorAuthMiddleware, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const service = symposiumProductionHost?.personalConnections;
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
  app.post(
    '/api/symposium/personal/connections/:id/disconnect',
    operatorAuthMiddleware,
    async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const service = symposiumProductionHost?.personalConnections;
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
    },
  );
  app.post(
    [
      '/api/symposium/personal/connections/:id/models/refresh',
      '/api/symposium/personal/connections/:id/models/recover',
    ],
    operatorAuthMiddleware,
    async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const discover = req.path.endsWith('/recover')
        ? symposiumProductionHost?.personalConnections?.recoverDiscovery
        : symposiumProductionHost?.personalConnections?.discoverModels;
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
  app.post(
    '/api/symposium/personal/connections/:id/routing-diagnostic',
    operatorAuthMiddleware,
    createPersonalRoutingDiagnosticHandler(
      () => symposiumProductionHost?.personalConnections?.diagnoseRouting,
    ),
  );
  return {
    app,
    select: (value: typeof service) => {
      symposiumProductionHost = { personalConnections: value };
    },
  };
}
