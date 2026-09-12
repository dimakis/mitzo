import express from 'express';
import { randomUUID } from 'node:crypto';
import { ConnectionStore, RevisionConflictError } from './connections-store.js';
import { ConnectionsService } from './connections-service.js';
import {
  ConnectionAssignmentsBody,
  ConnectionCreateBody,
  ConnectionReauthorizeBody,
  ConnectionRevisionBody,
} from './api-schemas.js';
import { verifyPassphrase, type AuthSession } from './auth.js';

const recent = new Map<string, { csrf: string; expiresAt: number }>();
const owner = 'operator';
function noStore(res: express.Response) {
  res.set('Cache-Control', 'no-store');
}
function browser(req: express.Request, res: express.Response): AuthSession | undefined {
  const session = res.locals.authSession as AuthSession | undefined;
  if (!session) {
    res.status(401).json({ error: 'Browser authentication required' });
    return;
  }
  return session;
}
function capability(req: express.Request, res: express.Response, csrf: string) {
  const session = browser(req, res);
  if (!session) return false;
  const current = recent.get(session.id);
  if (!current || current.expiresAt < Date.now() || current.csrf !== csrf) {
    res.status(403).json({ error: 'Recent reauthorization required' });
    return false;
  }
  return true;
}
export function createConnectionsRouter(options: {
  store: ConnectionStore;
  service: ConnectionsService;
  eligibleAccounts: () => string[];
}) {
  const router = express.Router();
  router.use((_, res, next) => {
    noStore(res);
    next();
  });
  router.get('/', (_req, res) =>
    res.json({
      connections: options.store.list(owner),
      legacy: ['github', 'google-workspace'],
      eligibleAccounts: options.eligibleAccounts(),
      appliesTo: 'new conversations only',
    }),
  );
  router.get('/:id/audit', (req, res) => res.json({ audit: options.store.audit(req.params.id) }));
  router.post('/reauthorize', express.json({ limit: '2kb' }), (req, res) => {
    const session = browser(req, res);
    const parsed = ConnectionReauthorizeBody.safeParse(req.body);
    if (!session || !parsed.success || !verifyPassphrase(parsed.data.passphrase))
      return res.status(403).json({ error: 'Reauthorization failed' });
    const csrf = randomUUID() + randomUUID();
    recent.set(session.id, { csrf, expiresAt: Date.now() + 5 * 60_000 });
    res.json({ csrf, expiresAt: Date.now() + 5 * 60_000 });
  });
  router.post('/', express.json({ limit: '8kb' }), async (req, res) => {
    if (!browser(req, res)) return;
    const parsed = ConnectionCreateBody.safeParse(req.body);
    const csrf = req.header('x-csrf-token') ?? '';
    if (!parsed.success || !capability(req, res, csrf)) {
      if (!res.headersSent) res.status(400).json({ error: 'Invalid connection request' });
      return;
    }
    if (parsed.data.accountIds.some((id) => !options.eligibleAccounts().includes(id)))
      return res.status(400).json({ error: 'Account is not eligible for managed Jira access' });
    const id = randomUUID();
    const connection = options.store.create({
      ownerId: owner,
      templateId: 'jira-readonly',
      templateVersion: 1,
      label: parsed.data.label,
      endpoint: 'https://redhat.atlassian.net',
      gatewayProviderName: `mitzo-conn-${id}`,
      desiredAccountIds: parsed.data.accountIds,
      submittedEmail: parsed.data.email,
    });
    try {
      const active = await options.service.provision(
        connection,
        parsed.data.token,
        new AbortController().signal,
      );
      res.status(201).json({ connection: active });
    } catch {
      res
        .status(422)
        .json({
          error: 'Connection verification failed',
          connection: options.store.get(connection.id),
        });
    }
  });
  router.put('/:id/assignments', express.json({ limit: '4kb' }), (req, res) => {
    if (!browser(req, res)) return;
    const parsed = ConnectionAssignmentsBody.safeParse(req.body);
    if (!parsed.success || !capability(req, res, parsed.success ? parsed.data.csrf : ''))
      return !res.headersSent
        ? res.status(400).json({ error: 'Invalid assignment request' })
        : undefined;
    if (parsed.data.accountIds.some((id) => !options.eligibleAccounts().includes(id)))
      return res.status(400).json({ error: 'Account is not eligible for managed Jira access' });
    try {
      res.json({
        connection: options.store.setAssignments(
          req.params.id,
          parsed.data.revision,
          parsed.data.accountIds,
          owner,
        ),
      });
    } catch (error) {
      res
        .status(error instanceof RevisionConflictError ? 409 : 400)
        .json({
          error:
            error instanceof RevisionConflictError
              ? 'Connection changed; refresh and try again.'
              : 'Assignment failed',
        });
    }
  });
  router.post('/:id/revoke', express.json({ limit: '4kb' }), async (req, res) => {
    if (!browser(req, res)) return;
    const parsed = ConnectionRevisionBody.safeParse(req.body);
    if (!parsed.success || !capability(req, res, parsed.success ? parsed.data.csrf : ''))
      return !res.headersSent
        ? res.status(400).json({ error: 'Invalid revoke request' })
        : undefined;
    try {
      res.json({
        connection: await options.service.revoke(
          req.params.id,
          parsed.data.revision,
          owner,
          new AbortController().signal,
        ),
      });
    } catch {
      res.status(409).json({ error: 'Revocation is pending; retry later.' });
    }
  });
  return router;
}
