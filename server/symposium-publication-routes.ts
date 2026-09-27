import { custodianPublicationSignal } from './symposium-custodian-authority.js';
import express from 'express';
import { z } from 'zod';
import type { AuthSession } from './auth.js';
import {
  requireSameOriginJson,
  requireRecentConnectionAuthorization,
  recentAppReauthorizationHandlers,
} from './connections-router.js';
import type { PublicationRegistration } from './symposium-publication-registration.js';
import type { CapabilityApproval } from './connections/capabilities/types.js';
const id = z.string().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const selection = z.strictObject({
  recordId: id,
  recordHash: hash,
  sealId: id,
  sealHash: hash,
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  connectionId: id,
  connectionRevision: z.number().int().positive(),
  credentialGeneration: id,
});
const principal = z.strictObject({
  host: z.literal('github.com'),
  numericId: z.number().int().positive().safe(),
  login: z.string().regex(/^[A-Za-z0-9-]{1,39}$/),
});
export function createPublicationRouter(deps: {
  registration(): PublicationRegistration | undefined;
  hasSession(id: string): boolean;
  approval(
    req: express.Request,
    session: AuthSession,
    conversationId: string,
  ): CapabilityApproval | undefined;
}) {
  const router = express.Router({ mergeParams: true });
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const session = res.locals.authSession as AuthSession | undefined;
    if (!session || session.expiresAt <= Date.now())
      return res.status(401).json({ error: 'Interactive authentication required' });
    if (!deps.hasSession(String(req.params.id)))
      return res.status(404).json({ error: 'Symposium session not found' });
    next();
  });
  // App-local credential-free reauthorization remains available in supervised mode.
  router.post('/recovery/reauthorize', ...recentAppReauthorizationHandlers());
  router.get('/recovery', (req: express.Request, res: express.Response) => {
    try {
      const query = z.strictObject({ recordId: id, recordHash: hash }).parse(req.query);
      res.json({
        operations:
          deps
            .registration()
            ?.service.recoveryCandidates(String(req.params.id), query.recordId, query.recordHash) ??
          [],
      });
    } catch {
      res.status(409).json({ error: 'Exact review record recovery unavailable' });
    }
  });
  router.get('/', (_req, res) => {
    const runtime = deps.registration();
    res.json({
      ...(runtime?.service.availability() ?? {
        available: false,
        code: 'PUBLICATION_CREDENTIAL_REGISTRATION_REQUIRED',
      }),
      credentials: runtime?.custodian.list() ?? [],
    });
  });
  router.use(requireSameOriginJson);
  const route = (
    path: string,
    run: (
      runtime: PublicationRegistration,
      req: express.Request,
      session: AuthSession,
      signal: AbortSignal,
    ) => Promise<unknown>,
  ) =>
    router.post(path, async (req, res) => {
      if (
        path === '/recovery' &&
        !requireRecentConnectionAuthorization(res, req.header('x-csrf-token') ?? '')
      )
        return;
      const runtime = deps.registration();
      if (!runtime) return res.status(503).json({ error: 'Publication registration unavailable' });
      const session = res.locals.authSession as AuthSession;
      const disconnected = new AbortController();
      const close = () => {
        if (!res.writableEnded) disconnected.abort();
      };
      res.on('close', close);
      try {
        const retainedSignal = custodianPublicationSignal(req);
        const signal = AbortSignal.any([
          runtime.authorize(session),
          disconnected.signal,
          ...(retainedSignal ? [retainedSignal] : []),
        ]);
        signal.throwIfAborted();
        const result = await run(runtime, req, session, signal);
        signal.throwIfAborted();
        res.json(result);
      } catch {
        res.status(409).json({
          error:
            path === '/recovery'
              ? 'Read-only recovery unavailable; the original operation remains unchanged'
              : 'Publication request unavailable or changed; refresh the selected credential and reviewed artifact',
        });
      } finally {
        res.off('close', close);
      }
    });
  route('/recovery', async (runtime, req, session, signal) => {
    const selected = z
      .strictObject({
        recordId: id,
        recordHash: hash,
        sealId: id,
        sealHash: hash,
        repository: selection.shape.repository,
        operationId: id,
        grantId: id,
        bindingHash: hash,
        connectionId: id,
        connectionRevision: z.number().int().positive(),
        credentialGeneration: id,
      })
      .parse(req.body);
    return runtime.service.recoverExact(
      { ...selected, sessionId: String(req.params.id) },
      session.id,
      signal,
    );
  });
  route('/artifact', async (runtime, req, _session, signal) => {
    const input = z.strictObject({ recordId: id }).parse(req.body);
    if (!runtime.describeArtifact) throw new Error('Completed artifact unavailable');
    return runtime.describeArtifact(String(req.params.id), input.recordId, signal);
  });
  route('/select', async (runtime, req, _session, signal) => {
    const input = z
      .strictObject({ connectionId: id, revision: z.number().int().positive() })
      .parse(req.body);
    const handle = await runtime.custodian.select(input.connectionId, input.revision);
    signal.throwIfAborted();
    return {
      connectionId: handle.connectionId,
      connectionRevision: handle.revision,
      credentialGeneration: handle.generation,
    };
  });
  route('/disconnect', async (runtime, req) => {
    const input = z
      .strictObject({ connectionId: id, revision: z.number().int().positive() })
      .parse(req.body);
    runtime.custodian.disconnect(input.connectionId, input.revision);
    return { disconnected: true };
  });
  route('/preview', async (runtime, req, session, signal) => {
    const scope = {
      ...selection.parse(req.body),
      operatorId: session.id,
      sessionId: String(req.params.id),
    };
    return { scope, principal: await runtime.authority.preview(scope, signal) };
  });
  route('/grant', async (runtime, req, session, signal) => {
    const input = z.strictObject({ selection, principal }).parse(req.body);
    return runtime.authority.grant(
      { ...input.selection, operatorId: session.id, sessionId: String(req.params.id) },
      input.principal,
      signal,
    );
  });
  route('/revoke', async (runtime, req, session) => {
    const input = z.strictObject({ grantId: id }).parse(req.body);
    runtime.authority.revoke(input.grantId, session.id, String(req.params.id));
    return { revoked: true };
  });
  route('/publish', async (runtime, req, session, signal) => {
    const input = z
      .strictObject({
        grantId: id,
        bindingHash: hash,
        turnId: id,
        idempotencyKey: id,
        baseBranch: id,
        title: z.string().min(1).max(256),
        body: z.string().max(60000),
        draft: z.boolean(),
      })
      .parse(req.body);
    const approval = deps.approval(req, session, String(req.params.id));
    if (!approval) throw new Error('Authenticated controller approval unavailable');
    const proof = await runtime.authority.require(input.grantId, input.bindingHash, signal);
    if (
      proof.grant.scope.operatorId !== session.id ||
      proof.grant.scope.sessionId !== req.params.id
    )
      throw new Error('Publication grant owner mismatch');
    const artifact = await runtime.artifact.require(proof.grant.scope, signal);
    return runtime.service.invoke(
      {
        grantId: input.grantId,
        bindingHash: input.bindingHash,
        turnId: input.turnId,
        idempotencyKey: input.idempotencyKey,
        publication: {
          repositoryPath: artifact.repositoryPath,
          baseBranch: input.baseBranch,
          title: input.title,
          body: input.body,
          draft: input.draft,
        },
      },
      signal,
      approval,
    );
  });
  return router;
}
