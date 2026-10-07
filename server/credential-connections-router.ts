import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { AuthSession } from './auth.js';
import {
  recentAppReauthorizationHandlers,
  requireRecentConnectionAuthorization,
  requireSameOriginJson,
} from './connections-router.js';
import { CredentialConnections, ConnectionInputSchema } from './credential-connections.js';
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
export function createCredentialConnectionsRouter(service: CredentialConnections) {
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
  const conflict = error instanceof Error && error.message.startsWith('Connection changed');
  return res.status(conflict ? 409 : 422).json({
    error: keychain
      ? error.message
      : conflict
        ? 'Connection changed; refresh and retry'
        : 'Connection operation failed. Check the destination, permissions and Keychain setup.',
  });
}
