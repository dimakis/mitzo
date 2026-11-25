import { Router, type Request, type Response } from 'express';
import { z, ZodError } from 'zod';
import {
  ORDINARY_COMMAND_STARTUP_TIMEOUT_MS,
  SessionLaunchApprovalSchema,
  SessionLaunchDefaultSaveSchema,
} from '@mitzo/protocol';
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
import { createLogger } from './logger.js';

const reference = z.string().min(1).max(200).regex(/^\S+$/);
const log = createLogger('session-launch');

/** Every refused or failed launch request is observable with a stable code and
 * its proposal ID. The reason is the same operator-facing message the route
 * returns; unexpected causes log only their type, never payloads or prompts.
 * A request the client itself abandoned is expected and stays at debug. */
function logSessionLaunchRouteFailure(
  req: Request,
  status: number,
  error: unknown,
  cancelled: boolean,
) {
  const proposalId = z.uuid().safeParse(req.params.proposalId);
  const code =
    error instanceof SessionLaunchPreflightError
      ? error.code
      : error instanceof SessionLaunchError
        ? 'session_launch_refused'
        : error instanceof SessionLaunchDefaultsConflict
          ? 'session_launch_defaults_conflict'
          : error instanceof ZodError
            ? 'session_launch_invalid_request'
            : 'session_launch_unavailable';
  const fields = {
    code,
    status,
    method: req.method,
    route: req.route?.path as string | undefined,
    ...(proposalId.success ? { proposalId: proposalId.data } : {}),
    ...(error instanceof SessionLaunchError || error instanceof SessionLaunchDefaultsConflict
      ? { reason: error.message.slice(0, 300) }
      : { causeType: error instanceof Error ? error.name : typeof error }),
  };
  if (cancelled) log.debug('Session launch request cancelled', fields);
  else if (status >= 500) log.error('Session launch request failed', fields);
  else log.warn('Session launch request refused', fields);
}

export function createSessionLaunchRouter(deps: {
  controller: SessionLaunchController;
  session(id: string): { title: string } | undefined;
  withAuthority?<T>(
    auth: AuthSession,
    signal: AbortSignal,
    action: (authority: SessionLaunchAuthority) => Promise<T>,
  ): Promise<T>;
  /** Test seam; production shares New chat's ordinary startup deadline. */
  startupTimeoutMs?: number;
}) {
  const router = Router();
  const { defaults, launches } = deps.controller;
  const owner = SESSION_LAUNCH_OWNER;
  const startupTimeoutMs = deps.startupTimeoutMs ?? ORDINARY_COMMAND_STARTUP_TIMEOUT_MS;
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    const auth = res.locals.authSession as AuthSession | undefined;
    if (!auth || !isAuthSessionCurrent(auth))
      return res.status(403).json({ error: 'Sign in to manage sessions.' });
    next();
  });
  type Action = (auth: AuthSession, signal: AbortSignal) => Promise<unknown> | unknown;
  const perform = async (
    req: Request,
    res: Response,
    action: Action,
    options: { lifetime: 'request' | 'startup'; respond?: (value: unknown) => void },
  ) => {
    const auth = res.locals.authSession as AuthSession;
    const respond =
      options.respond ??
      ((value: unknown) => {
        res.json(value);
      });
    const controller = new AbortController();
    const abort = () => controller.abort();
    const close = () => {
      if (!res.writableEnded) abort();
    };
    const unregister = registerAuthSession(auth, abort);
    const deadline =
      options.lifetime === 'startup'
        ? setTimeout(
            () =>
              controller.abort(
                new DOMException('Session launch startup deadline exceeded', 'TimeoutError'),
              ),
            startupTimeoutMs,
          )
        : undefined;
    if (options.lifetime === 'request') {
      req.once('aborted', abort);
      res.once('close', close);
    }
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
      logSessionLaunchRouteFailure(req, status, error, controller.signal.aborted);
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
      clearTimeout(deadline);
      unregister();
      req.off('aborted', abort);
      res.off('close', close);
    }
  };
  /** Reads and local record edits end with their client. */
  const act = (req: Request, res: Response, action: Action, respond?: (value: unknown) => void) =>
    perform(req, res, action, { lifetime: 'request', respond });
  /** Start, approve, resume and release commit workspace, session, provider and
   * Telos effects. A phone backgrounding mid-request is not a cancellation:
   * aborting there leaves an unconfirmed command that blocks the child chat.
   * Login revocation and New chat's startup deadline still bound the work, and
   * the retained record reports its outcome on the client's next read. */
  const commit = (req: Request, res: Response, action: Action) =>
    perform(req, res, action, { lifetime: 'startup' });
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
    commit(req, res, (auth, signal) =>
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
    commit(req, res, async (auth, signal) => {
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
    commit(req, res, async (auth, signal) => {
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
    commit(req, res, async (auth, signal) => {
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
