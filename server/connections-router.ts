import express from 'express';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import type { Connection } from './connections-store.js';
import { ConnectionStore, RevisionConflictError } from './connections-store.js';
import { ConnectionsService } from './connections-service.js';
import {
  ConnectionAssignmentsBody,
  ConnectionCreateBody,
  ConnectionReauthorizeBody,
  ConnectionRevisionBody,
  ConnectionRotateBody,
} from './api-schemas.js';
import { verifyPassphrase, type AuthSession } from './auth.js';

const OWNER = 'operator',
  TTL = 5 * 60_000,
  MAX_CAPABILITIES = 256;
const capabilities = new Map<string, { csrf: string; expiresAt: number }>();
type PublicConnection = Pick<
  Connection,
  | 'id'
  | 'templateId'
  | 'templateVersion'
  | 'label'
  | 'endpoint'
  | 'status'
  | 'revision'
  | 'desiredAccountIds'
  | 'identity'
  | 'verifiedAt'
  | 'errorCode'
  | 'createdAt'
  | 'updatedAt'
>;
const publicConnection = (c: Connection): PublicConnection => {
  const {
    id,
    templateId,
    templateVersion,
    label,
    endpoint,
    status,
    revision,
    desiredAccountIds,
    identity,
    verifiedAt,
    errorCode,
    createdAt,
    updatedAt,
  } = c;
  return {
    id,
    templateId,
    templateVersion,
    label,
    endpoint,
    status,
    revision,
    desiredAccountIds,
    identity,
    verifiedAt,
    errorCode,
    createdAt,
    updatedAt,
  };
};
function session(res: express.Response): AuthSession | undefined {
  const value = res.locals.authSession as AuthSession | undefined;
  if (!value || value.expiresAt <= Date.now()) {
    res.status(401).json({ error: 'Browser authentication required' });
    return;
  }
  return value;
}
function requireCapability(res: express.Response, csrf: string) {
  const value = session(res);
  if (!value) return false;
  const capability = capabilities.get(value.id);
  if (!capability || capability.expiresAt <= Date.now() || capability.csrf !== csrf) {
    capabilities.delete(value.id);
    res.status(403).json({ error: 'Recent reauthorization required' });
    return false;
  }
  return true;
}
function unsafe(req: express.Request, res: express.Response, next: express.NextFunction) {
  const origin = req.header('origin');
  const allowed = new Set(
    (process.env.CORS_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
  );
  const host = req.get('host');
  if (host) allowed.add(`${req.protocol}://${host}`);
  if (origin && !allowed.has(origin)) return res.status(403).json({ error: 'Untrusted origin' });
  if (!req.is('application/json'))
    return res.status(415).json({ error: 'Content-Type must be application/json' });
  next();
}
function missing(res: express.Response) {
  return res.status(404).json({ error: 'Connection not found' });
}
function connectionId(req: express.Request) {
  return typeof req.params.id === 'string' ? req.params.id : '';
}
function error(res: express.Response, value: unknown, fallback: string) {
  return res.status(value instanceof RevisionConflictError ? 409 : 422).json({
    error:
      value instanceof RevisionConflictError
        ? 'Connection changed; refresh and try again.'
        : fallback,
  });
}

/** Must be mounted immediately behind authMiddleware. Internal-token callers lack authSession and are denied. */
export function createConnectionsRouter(options: {
  store: ConnectionStore;
  service: ConnectionsService;
  eligibleAccounts: () => string[];
  gateway: string;
  workspace: string;
  legacyProviders: () => Promise<Array<{ name: string; type: string }>>;
}) {
  const router = express.Router();
  const limiter = (limit: number, message: string) =>
    rateLimit({
      windowMs: 60_000,
      limit,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: message },
    });
  const reauthorize = limiter(5, 'Too many reauthorization attempts, try again in a minute');
  const mutate = limiter(30, 'Too many connection requests, try again in a minute');
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (session(res)) next();
  });
  router.get('/', async (_req, res) => {
    let legacy: Array<{ id: string; label: string; type: string; management: string }> = [];
    try {
      legacy = (await options.legacyProviders()).map((provider) => ({
        id: provider.name,
        label: provider.name,
        type: provider.type,
        management: 'operator-managed',
      }));
    } catch {
      // A gateway read failure must not expose stale or invented legacy state.
    }
    return res.json({
      connections: options.store.list(OWNER).map(publicConnection),
      legacy,
      eligibleAccounts: options.eligibleAccounts(),
      appliesTo: 'new conversations only',
    });
  });
  router.get('/:id/audit', (req, res) => {
    const c = options.store.get(connectionId(req));
    return !c || c.ownerId !== OWNER
      ? missing(res)
      : res.json({ audit: options.store.audit(c.id) });
  });
  router.post('/reauthorize', reauthorize, unsafe, express.json({ limit: '2kb' }), (req, res) => {
    const auth = session(res),
      parsed = ConnectionReauthorizeBody.safeParse(req.body);
    if (!auth || !parsed.success || !verifyPassphrase(parsed.data.passphrase))
      return res.status(403).json({ error: 'Reauthorization failed' });
    const now = Date.now();
    for (const [id, item] of capabilities) if (item.expiresAt <= now) capabilities.delete(id);
    while (capabilities.size >= MAX_CAPABILITIES)
      capabilities.delete(capabilities.keys().next().value!);
    const expiresAt = Math.min(auth.expiresAt, now + TTL),
      csrf = randomUUID() + randomUUID();
    capabilities.set(auth.id, { csrf, expiresAt });
    return res.json({ csrf, expiresAt });
  });
  router.post('/', mutate, unsafe, express.json({ limit: '8kb' }), async (req, res) => {
    const parsed = ConnectionCreateBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid connection request' });
    if (!requireCapability(res, req.header('x-csrf-token') ?? '')) return;
    if (parsed.data.accountIds.some((id) => !options.eligibleAccounts().includes(id)))
      return res.status(400).json({ error: 'Account is not eligible for managed Jira access' });
    try {
      const c = await options.service.createAndProvision(
        {
          ownerId: OWNER,
          templateId: 'jira-readonly',
          templateVersion: 1,
          label: parsed.data.label,
          endpoint: 'https://redhat.atlassian.net',
          gatewayProviderName: `mitzo-conn-${randomUUID()}`,
          gateway: options.gateway,
          workspace: options.workspace,
          submittedEmail: parsed.data.email,
          desiredAccountIds: parsed.data.accountIds,
        },
        parsed.data.token,
        AbortSignal.timeout(120_000),
      );
      return res.status(201).json({ connection: publicConnection(c) });
    } catch {
      return res.status(422).json({ error: 'Connection verification failed' });
    }
  });
  router.post('/:id/test', mutate, unsafe, express.json({ limit: '2kb' }), async (req, res) => {
    const parsed = ConnectionRevisionBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid test request' });
    if (!requireCapability(res, parsed.data.csrf)) return;
    const c = options.store.get(connectionId(req));
    if (!c || c.ownerId !== OWNER) return missing(res);
    try {
      return res.json({
        connection: publicConnection(
          await options.service.test(c.id, parsed.data.revision, AbortSignal.timeout(120_000)),
        ),
      });
    } catch (value) {
      return error(res, value, 'Connection verification failed');
    }
  });
  router.post('/:id/rotate', mutate, unsafe, express.json({ limit: '8kb' }), async (req, res) => {
    const parsed = ConnectionRotateBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid rotation request' });
    if (!requireCapability(res, parsed.data.csrf)) return;
    const c = options.store.get(connectionId(req));
    if (!c || c.ownerId !== OWNER) return missing(res);
    try {
      return res.json({
        connection: publicConnection(
          await options.service.rotate(
            c.id,
            parsed.data.revision,
            parsed.data.token,
            AbortSignal.timeout(120_000),
          ),
        ),
      });
    } catch (value) {
      return error(res, value, 'Connection rotation failed');
    }
  });
  router.post('/:id/retry', mutate, unsafe, express.json({ limit: '8kb' }), async (req, res) => {
    const parsed = ConnectionRotateBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid retry request' });
    if (!requireCapability(res, parsed.data.csrf)) return;
    const c = options.store.get(connectionId(req));
    if (!c || c.ownerId !== OWNER) return missing(res);
    try {
      return res.json({
        connection: publicConnection(
          await options.service.retry(
            c.id,
            parsed.data.revision,
            parsed.data.token,
            AbortSignal.timeout(120_000),
          ),
        ),
      });
    } catch (value) {
      return error(res, value, 'Connection verification failed');
    }
  });
  router.put(
    '/:id/assignments',
    mutate,
    unsafe,
    express.json({ limit: '4kb' }),
    async (req, res) => {
      const parsed = ConnectionAssignmentsBody.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid assignment request' });
      if (!requireCapability(res, parsed.data.csrf)) return;
      const c = options.store.get(connectionId(req));
      if (!c || c.ownerId !== OWNER) return missing(res);
      if (parsed.data.accountIds.some((id) => !options.eligibleAccounts().includes(id)))
        return res.status(400).json({ error: 'Account is not eligible for managed Jira access' });
      try {
        return res.json({
          connection: publicConnection(
            await options.service.setAssignments(
              c.id,
              parsed.data.revision,
              parsed.data.accountIds,
              OWNER,
              AbortSignal.timeout(120_000),
            ),
          ),
        });
      } catch (value) {
        return res.status(value instanceof RevisionConflictError ? 409 : 400).json({
          error:
            value instanceof RevisionConflictError
              ? 'Connection changed; refresh and try again.'
              : 'Assignment failed',
        });
      }
    },
  );
  router.post('/:id/revoke', mutate, unsafe, express.json({ limit: '2kb' }), async (req, res) => {
    const parsed = ConnectionRevisionBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid revoke request' });
    if (!requireCapability(res, parsed.data.csrf)) return;
    const c = options.store.get(connectionId(req));
    if (!c || c.ownerId !== OWNER) return missing(res);
    try {
      return res.json({
        connection: publicConnection(
          await options.service.revoke(
            c.id,
            parsed.data.revision,
            OWNER,
            AbortSignal.timeout(120_000),
          ),
        ),
      });
    } catch (value) {
      return error(res, value, 'Revocation is pending; retry later.');
    }
  });
  // express.json() may expose parser details through a global error handler. Keep
  // connection bodies out of both responses and logs, including malformed secrets.
  router.use(
    (
      parserError: { type?: string; status?: number },
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if (res.headersSent) return next(parserError);
      if (parserError.type === 'entity.too.large' || parserError.status === 413)
        return res.status(413).json({ error: 'Body too large' });
      if (parserError.type === 'entity.parse.failed' || parserError.status === 400)
        return res.status(400).json({ error: 'Invalid JSON' });
      return next(parserError);
    },
  );
  return router;
}
