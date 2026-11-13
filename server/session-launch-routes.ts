import { Router, type Request, type Response } from 'express';
import { z, ZodError } from 'zod';
import { SessionLaunchApprovalSchema, SessionLaunchDefaultSaveSchema } from '@mitzo/protocol';
import { isAuthSessionCurrent, registerAuthSession, type AuthSession } from './auth.js';
import { requireSameOriginJson } from './connections-router.js';
import { SessionLaunchDefaultsConflict, SESSION_LAUNCH_OWNER } from './session-launch-defaults.js';
import {
  SessionLaunchError,
  SessionLaunchPreflightError,
  publicSessionLaunchRecord,
} from './session-launch-store.js';
import type { SessionLaunchController } from './session-launch-controller.js';
import type { SessionLaunchAuthority } from './session-launch-service.js';

const reference = z.string().min(1).max(200).regex(/^\S+$/);
export function createSessionLaunchRouter(deps: {
  controller: SessionLaunchController;
  session(id: string): { title: string } | undefined;
  withAuthority?<T>(
    auth: AuthSession,
    signal: AbortSignal,
    action: (authority: SessionLaunchAuthority) => Promise<T>,
  ): Promise<T>;
}) {
  const router = Router();
  const { defaults, launches } = deps.controller;
  const owner = SESSION_LAUNCH_OWNER;
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    const auth = res.locals.authSession as AuthSession | undefined;
    if (!auth || !isAuthSessionCurrent(auth))
      return res.status(403).json({ error: 'Sign in to manage sessions.' });
    next();
  });
  const act = async (
    req: Request,
    res: Response,
    action: (auth: AuthSession, signal: AbortSignal) => Promise<unknown> | unknown,
    respond: (value: unknown) => void = (value) => {
      res.json(value);
    },
  ) => {
    const auth = res.locals.authSession as AuthSession;
    const controller = new AbortController();
    const abort = () => controller.abort();
    const close = () => {
      if (!res.writableEnded) abort();
    };
    const unregister = registerAuthSession(auth, abort);
    req.once('aborted', abort);
    res.once('close', close);
    try {
      if (!isAuthSessionCurrent(auth))
        throw new SessionLaunchError('Session authorization expired.', 403);
      const result = await action(auth, controller.signal);
      controller.signal.throwIfAborted();
      if (!isAuthSessionCurrent(auth))
        throw new SessionLaunchError('Session authorization expired.', 403);
      respond(result);
    } catch (error) {
      const status =
        error instanceof SessionLaunchError
          ? error.status
          : error instanceof SessionLaunchDefaultsConflict
            ? 409
            : error instanceof ZodError
              ? 400
              : 503;
      res.status(status).json({
        ...(error instanceof SessionLaunchPreflightError
          ? { code: error.code, effectStatus: error.effectStatus }
          : {}),
        error:
          status === 503
            ? 'Session creation is temporarily unavailable. Check the retained request before retrying.'
            : error instanceof SessionLaunchDefaultsConflict || error instanceof SessionLaunchError
              ? error.message
              : 'Review the complete session configuration.',
      });
    } finally {
      unregister();
      req.off('aborted', abort);
      res.off('close', close);
    }
  };
  const withAuthority = async <T>(
    auth: AuthSession,
    signal: AbortSignal,
    action: (authority: SessionLaunchAuthority) => Promise<T>,
  ): Promise<T> => {
    if (deps.withAuthority) return deps.withAuthority(auth, signal, action);
    const { withAgentLibraryRecoveryAuthorization } = await import('./agent-library-transport.js');
    return withAgentLibraryRecoveryAuthorization(auth, async (connectionId) => {
      if (!connectionId) throw new SessionLaunchError('Authenticated operator required.', 403);
      return action({
        operatorConnectionId: connectionId,
        authSessionId: auth.id,
        signal,
        assertCurrent() {
          signal.throwIfAborted();
          if (!isAuthSessionCurrent(auth))
            throw new SessionLaunchError('Session authorization expired.', 403);
        },
      });
    });
  };
  const source = (id: string) => {
    const record = launches.store.get(id, owner);
    if (!deps.session(record.sourceSessionId))
      throw new SessionLaunchError('Originating chat is unavailable.', 404);
    return record;
  };
  router.get('/defaults', (req, res) => act(req, res, () => defaults.get(owner)));
  router.put('/defaults', requireSameOriginJson, (req, res) =>
    act(req, res, () => defaults.save(owner, SessionLaunchDefaultSaveSchema.parse(req.body))),
  );
  router.post('/requests/start', requireSameOriginJson, (req, res) =>
    act(req, res, (auth, signal) =>
      withAuthority(auth, signal, async (authority) => {
        const { sourceSessionId, requestId, saveAsDefault, ...edits } =
          SessionLaunchApprovalSchema.omit({ expectedRevision: true })
            .extend({ sourceSessionId: reference, requestId: z.uuid() })
            .parse(req.body);
        if (!deps.session(sourceSessionId))
          throw new SessionLaunchError('Originating chat is unavailable.', 404);
        authority.assertCurrent();
        const record = launches.store.propose({
          ...edits,
          operatorId: owner,
          sourceSessionId,
          requestId,
          originalInput: { ...edits, saveAsDefault },
        });
        const defaultRevision = saveAsDefault ? defaults.get(owner).revision : undefined;
        const approved = await launches.approve(
          record.proposalId,
          owner,
          edits,
          record.revision,
          authority,
          saveAsDefault
            ? (database) => {
                authority.assertCurrent();
                defaults.saveInTransaction(
                  owner,
                  { expectedRevision: defaultRevision!, configuration: edits.configuration },
                  database,
                );
              }
            : undefined,
        );
        deps.controller.changed(sourceSessionId);
        if (approved.childSessionId) deps.controller.changed(approved.childSessionId);
        return publicSessionLaunchRecord(approved);
      }),
    ),
  );
  router.put('/links/:source/:target', requireSameOriginJson, (req, res) =>
    act(req, res, () => {
      const first = reference.parse(req.params.source),
        second = reference.parse(req.params.target);
      const a = deps.session(first),
        b = deps.session(second);
      if (!a || !b)
        throw new SessionLaunchError('Chat is unavailable. Refresh before linking.', 404);
      launches.store.link(owner, first, second, a.title, b.title);
      deps.controller.changed(first);
      deps.controller.changed(second);
      return { linked: true };
    }),
  );
  router.delete('/links/:source/:target', requireSameOriginJson, (req, res) =>
    act(req, res, () => {
      const first = reference.parse(req.params.source),
        second = reference.parse(req.params.target);
      if (!deps.session(first)) throw new SessionLaunchError('Chat is unavailable.', 404);
      launches.store.unlink(owner, first, second);
      deps.controller.changed(first);
      deps.controller.changed(second);
      return { linked: false };
    }),
  );
  router.get('/requests', (req, res) =>
    act(req, res, async (auth, signal) => {
      const sessionId = reference.parse(req.query.sessionId);
      if (!deps.session(sessionId)) throw new SessionLaunchError('Chat is unavailable.', 404);
      const records = launches.store.forSession(sessionId, owner);
      const refreshed = await withAuthority(auth, signal, async (authority) => {
        const result = [];
        for (const record of records)
          result.push(await launches.refresh(record.proposalId, owner, authority));
        return result;
      });
      const origin = refreshed.find((record) => record.childSessionId === sessionId);
      return {
        links: launches.store.linked(sessionId, owner).map((link) => ({
          sessionId: link.sessionId,
          title: deps.session(link.sessionId)?.title ?? link.title,
          available: Boolean(deps.session(link.sessionId)),
        })),
        requests: refreshed
          .filter((record) => record.sourceSessionId === sessionId)
          .map(publicSessionLaunchRecord),
        ...(origin && deps.session(origin.sourceSessionId)
          ? {
              origin: {
                sessionId: origin.sourceSessionId,
                title: deps.session(origin.sourceSessionId)!.title,
              },
            }
          : {}),
      };
    }),
  );
  router.get('/requests/:proposalId', (req, res) =>
    act(req, res, (auth, signal) => {
      const id = z.uuid().parse(req.params.proposalId);
      source(id);
      return withAuthority(auth, signal, async (authority) =>
        publicSessionLaunchRecord(await launches.refresh(id, owner, authority)),
      );
    }),
  );
  // The handover is retained with the reviewed request, independent of agent
  // filesystem paths. Reading it never allocates, resumes or dispatches a chat.
  router.get('/requests/:proposalId/handover.md', (req, res) =>
    act(
      req,
      res,
      () => source(z.uuid().parse(req.params.proposalId)).prompt,
      (text) => {
        res.type('text/markdown').attachment('handover.md').send(text);
      },
    ),
  );
  router.post('/requests/:proposalId/approve', requireSameOriginJson, (req, res) =>
    act(req, res, async (auth, signal) => {
      const id = z.uuid().parse(req.params.proposalId);
      const record = source(id);
      const { expectedRevision, saveAsDefault, ...edits } = SessionLaunchApprovalSchema.parse(
        req.body,
      );
      const defaultRevision = saveAsDefault ? defaults.get(owner).revision : undefined;
      const approved = await withAuthority(auth, signal, async (authority) => {
        return launches.approve(
          id,
          owner,
          edits,
          expectedRevision,
          authority,
          saveAsDefault
            ? (database) => {
                authority.assertCurrent();
                defaults.saveInTransaction(
                  owner,
                  { expectedRevision: defaultRevision!, configuration: edits.configuration },
                  database,
                );
              }
            : undefined,
        );
      });
      deps.controller.changed(record.sourceSessionId);
      if (approved.childSessionId) deps.controller.changed(approved.childSessionId);
      return publicSessionLaunchRecord(approved);
    }),
  );
  router.post('/requests/:proposalId/resume', requireSameOriginJson, (req, res) =>
    act(req, res, async (auth, signal) => {
      const id = z.uuid().parse(req.params.proposalId);
      const record = source(id);
      const { expectedRevision } = z
        .strictObject({ expectedRevision: z.number().int().positive() })
        .parse(req.body);
      const resumed = await withAuthority(auth, signal, (authority) =>
        launches.resume(id, owner, expectedRevision, authority),
      );
      deps.controller.changed(record.sourceSessionId);
      if (resumed.childSessionId) deps.controller.changed(resumed.childSessionId);
      return publicSessionLaunchRecord(resumed);
    }),
  );
  router.post('/requests/:proposalId/cancel', requireSameOriginJson, (req, res) =>
    act(req, res, () => {
      const id = z.uuid().parse(req.params.proposalId);
      const record = source(id);
      const { expectedRevision } = z
        .strictObject({ expectedRevision: z.number().int().positive() })
        .parse(req.body);
      const result = launches.store.cancel(id, owner, expectedRevision);
      deps.controller.changed(record.sourceSessionId);
      return publicSessionLaunchRecord(result);
    }),
  );
  router.post('/requests/:proposalId/release', requireSameOriginJson, (req, res) =>
    act(req, res, async (auth, signal) => {
      const id = z.uuid().parse(req.params.proposalId),
        record = source(id);
      const { expectedRevision } = z
        .strictObject({ expectedRevision: z.number().int().positive() })
        .parse(req.body);
      const released = await withAuthority(auth, signal, (authority) =>
        launches.release(id, owner, expectedRevision, authority),
      );
      deps.controller.changed(record.sourceSessionId);
      return publicSessionLaunchRecord(released);
    }),
  );
  return router;
}
