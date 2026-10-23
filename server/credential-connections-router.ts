import type { SecretRelay } from './secret-relay.js';
import type { ConnectionSetup } from './credential-setup.js';
import { WebSocketConfigSchema } from './credential-websocket.js';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { isAuthSessionCurrent, type AuthSession } from './auth.js';
import {
  recentAppReauthorizationHandlers,
  recentAuthorizationExpiry,
  requireRecentConnectionAuthorization,
  requireSameOriginJson,
} from './connections-router.js';
import { CredentialConnections, ConnectionInputSchema } from './credential-connections.js';
import { DashboardAccessSchema } from './home-assistant-dashboard.js';
import { VaultReferenceSchema } from './keychain-vault.js';

const secret = z.string().min(1).max(16_384);
const create = z.union([
  z.object({ connection: ConnectionInputSchema, secret }).strict(),
  z
    .object({
      connection: ConnectionInputSchema,
      existing: VaultReferenceSchema.omit({ persistentRef: true }),
    })
    .strict(),
]);
const revision = z.object({ revision: z.number().int().positive() }).strict();
/** Browser-only control plane. Model tools can discover/request access, but cannot enroll or rotate credentials. */
export function createCredentialConnectionsRouter(
  service: CredentialConnections,
  options: {
    onRelayReady?: (relay: SecretRelay) => Promise<boolean>;
    canCompleteRelay?: (relay: SecretRelay) => boolean;
    onReady?: (setup: ConnectionSetup) => Promise<boolean>;
    canComplete?: (setup: ConnectionSetup) => boolean;
  } = {},
) {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const session = res.locals.authSession as AuthSession | undefined;
    if (!session || session.expiresAt <= Date.now())
      return res.status(401).json({ error: 'Browser authentication required' });
    next();
  });
  router.get('/', (_req, res) =>
    res.json({ connections: service.catalog(), storage: 'apple-keychain' }),
  );
  router.get('/relays/:id', (req, res) => {
    try {
      if (!service.relay) throw new Error();
      return res.json({ relay: service.relay.browserStatus(req.params.id) });
    } catch {
      return res.status(404).json({ error: 'Secret request unavailable' });
    }
  });
  router.get('/setups/:id', (req, res) => {
    try {
      return res.json({ setup: service.setups.browserStatus(req.params.id) });
    } catch {
      return res.status(404).json({ error: 'Setup unavailable' });
    }
  });
  router.get('/:id/sessions', (req, res) =>
    res.json({ sessions: service.sessions(req.params.id) }),
  );
  router.use(
    rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false }),
  );
  router.post('/reauthorize', ...recentAppReauthorizationHandlers());
  router.use(requireSameOriginJson);
  router.use(express.json({ limit: '24kb' }));
  router.use((req, res, next) => {
    if (requireRecentConnectionAuthorization(res, req.header('x-csrf-token') ?? '')) next();
  });
  router.post('/relays/:id/complete', async (req, res) => {
    const body = revision.extend({ secret }).strict().safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Invalid secret request' });
    try {
      if (!service.relay) throw new Error();
      const csrf = req.header('x-csrf-token') ?? '';
      const draft = service.relay.browserStatus(req.params.id);
      const allowed = () =>
        isAuthSessionCurrent(res.locals.authSession as AuthSession) &&
        (recentAuthorizationExpiry(res, csrf) ?? 0) > Date.now() &&
        (options.canCompleteRelay?.(draft) ?? false);
      if (!allowed())
        return res
          .status(409)
          .json({ error: 'Return to the originating chat before completing this request.' });
      const controller = new AbortController();
      const abort = () => controller.abort();
      const closed = () => {
        if (!res.writableEnded) abort();
      };
      req.once('aborted', abort);
      res.once('close', closed);
      let relay: SecretRelay;
      try {
        relay = await service.relay.complete(
          draft.id,
          body.data.revision,
          body.data.secret,
          AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
          allowed,
        );
      } finally {
        req.removeListener('aborted', abort);
        res.removeListener('close', closed);
      }
      if (options.onRelayReady) {
        try {
          if (await options.onRelayReady(relay))
            service.relay.markDelivered(relay.id, relay.revision);
        } catch {
          /* durable outbox retains readiness */
        }
        relay = service.relay.browserStatus(relay.id);
      }
      return res.json({ relay });
    } catch {
      return res.status(422).json({
        error: 'Secret save could not be confirmed. Check request status before continuing.',
      });
    }
  });
  router.post('/relays/:id/code', async (req, res) => {
    const body = revision
      .extend({ targetIndex: z.number().int().min(0).max(7), code: z.string().regex(/^\d{6,10}$/) })
      .strict()
      .safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Invalid verification request' });
    try {
      if (!service.relay) throw new Error();
      const draft = service.relay.browserStatus(req.params.id);
      const csrf = req.header('x-csrf-token') ?? '';
      const allowed = () =>
        isAuthSessionCurrent(res.locals.authSession as AuthSession) &&
        (recentAuthorizationExpiry(res, csrf) ?? 0) > Date.now() &&
        (options.canCompleteRelay?.(draft) ?? false);
      if (!allowed())
        return res
          .status(409)
          .json({ error: 'Return to the originating chat before completing this request.' });
      let relay = service.relay.provideBrowserCode(
        draft.id,
        body.data.revision,
        body.data.targetIndex,
        body.data.code,
        allowed,
      );
      if (options.onRelayReady) {
        try {
          if (await options.onRelayReady(relay))
            service.relay.markDelivered(relay.id, relay.revision);
        } catch {
          /* durable safe readiness notification remains pending */
        }
      }
      relay = service.relay.browserStatus(relay.id);
      return res.json({ relay });
    } catch {
      return res.status(409).json({
        error: 'Verification request changed. Check status before entering another code.',
      });
    }
  });
  router.post('/relays/:id/cancel', (req, res) => {
    const body = revision.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Invalid secret request' });
    try {
      if (!service.relay) throw new Error();
      return res.json({ relay: service.relay.cancel(req.params.id, body.data.revision) });
    } catch {
      return res.status(409).json({ error: 'Secret request changed; refresh its status.' });
    }
  });
  router.post('/setups/:id/complete', async (req, res) => {
    const body = revision.extend({ secret }).strict().safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Invalid setup request' });
    try {
      const csrf = req.header('x-csrf-token') ?? '';
      const authorizedUntil = recentAuthorizationExpiry(res, csrf) ?? 0;
      const draft = service.setups.browserStatus(req.params.id);
      const allowed = () => authorizedUntil > Date.now() && (options.canComplete?.(draft) ?? true);
      if (!allowed())
        return res
          .status(409)
          .json({ error: 'The originating chat is unavailable. Return to that chat and retry.' });
      let setup = await service.setups.complete(
        req.params.id,
        body.data.revision,
        body.data.secret,
        AbortSignal.timeout(30_000),
        allowed,
      );
      if (setup.status === 'ready' && setup.delivery !== 'delivered' && options.onReady) {
        // Failed delivery leaves a durable pending receipt, never replays enrollment.
        try {
          if (await options.onReady(setup)) service.setups.markDelivered(setup.id);
        } catch {
          /* retry on return */
        }
        setup = service.setups.browserStatus(setup.id);
      }
      return res.json({ setup });
    } catch (error) {
      return failure(res, error);
    }
  });
  router.post('/setups/:id/cancel', (req, res) => {
    const body = revision.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Invalid cancellation request' });
    try {
      return res.json({ setup: service.setups.cancel(req.params.id, body.data.revision) });
    } catch (error) {
      return failure(res, error);
    }
  });
  router.post('/', async (req, res) => {
    const body = create.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Invalid connection request' });
    try {
      return res.status(201).json({
        connection: await service.create(
          body.data.connection,
          'secret' in body.data ? { secret: body.data.secret } : { existing: body.data.existing },
        ),
      });
    } catch (error) {
      return failure(res, error);
    }
  });
  router.post('/:id/test', async (req, res) => {
    const body = revision.extend({ path: z.string().min(1).max(4096) }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Invalid test request' });
    try {
      return res.json(
        await service.test(
          req.params.id,
          body.data.revision,
          body.data.path,
          AbortSignal.timeout(30_000),
        ),
      );
    } catch (error) {
      return failure(res, error);
    }
  });
  router.post('/:id/websocket', (req, res) => {
    const body = revision
      .extend({ websocket: WebSocketConfigSchema.nullable() })
      .strict()
      .safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Invalid WebSocket setup request' });
    try {
      return res.json({
        connection: service.updateWebSocket(req.params.id, body.data.revision, body.data.websocket),
      });
    } catch (error) {
      return failure(res, error);
    }
  });
  router.post('/:id/dashboard-access', (req, res) => {
    const body = revision.extend({ access: DashboardAccessSchema }).strict().safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Invalid dashboard access request' });
    try {
      return res.json({
        connection: service.updateDashboardAccess(
          req.params.id,
          body.data.revision,
          body.data.access,
        ),
      });
    } catch (error) {
      return failure(res, error);
    }
  });
  router.post('/:id/rotate', async (req, res) => {
    const body = revision.extend({ secret }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Invalid rotation request' });
    try {
      return res.json({
        connection: await service.rotate(req.params.id, body.data.revision, body.data.secret),
      });
    } catch (error) {
      return failure(res, error);
    }
  });
  router.post('/:id/disable', (req, res) => {
    const body = revision.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Invalid disable request' });
    try {
      service.disable(req.params.id, body.data.revision);
      return res.json({ ok: true });
    } catch (error) {
      return failure(res, error);
    }
  });
  router.delete('/:id/sessions/:sessionId', (req, res) => {
    const body = revision.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Invalid revocation request' });
    try {
      service.connection(req.params.id, body.data.revision);
      service.revokeSession(req.params.sessionId, req.params.id);
      return res.json({ ok: true });
    } catch (error) {
      return failure(res, error);
    }
  });
  router.use(
    (
      error: { type?: string },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) =>
      res
        .status(error.type === 'entity.too.large' ? 413 : 400)
        .json({ error: 'Invalid connection input' }),
  );
  return router;
}
function failure(res: express.Response, error: unknown) {
  const keychain = error instanceof Error && error.name === 'KeychainUnavailableError';
  const conflict =
    error instanceof Error &&
    (error.message.startsWith('Connection changed') || error.message.startsWith('Setup changed'));
  return res.status(conflict ? 409 : 422).json({
    error: keychain
      ? error.message
      : conflict
        ? 'Connection changed; refresh and retry'
        : 'Connection operation failed. Check the destination, permissions and Keychain setup.',
  });
}
