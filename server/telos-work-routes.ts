import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import {
  TelosWorkControlCommandSchema,
  type TelosWorkControlCommand,
  TelosWorkCommandSchema,
  TelosWorkIdSchema,
  TelosSourceConversationReferenceSchema,
  TelosWorkDelegationInputSchema,
  TelosOrdinaryWorkDelegationInputSchema,
  TelosWorkDelegationReceiptSchema,
  TelosStartSliceInputSchema,
  TelosWorkLifecycleCommandSchema,
  TelosWorkLifecycleListSchema,
} from '@mitzo/protocol';
import { TelosWorkStore, TelosWorkError, type TelosWorkActor } from './telos-work-store.js';
import { isAuthSessionCurrent, registerAuthSession, type AuthSession } from './auth.js';
import { requireSameOriginJson } from './connections-router.js';

export interface TelosWorkRoleRequest {
  actor: TelosWorkActor;
  /** Middleware-verified authorization, never copied from JSON. */
  authorization?: AuthSession;
  raw: unknown;
  signal: AbortSignal;
  assertAuthorized(): void;
}

/** Operator mutations and scoped conversation reads share the same durable
 * store. Internal tokens are not operator authority. No route accepts a caller
 * actor, allocator receipt, provider/client binding or model launch command.
 */
export function createTelosWorkRouter(options: {
  dbPath(): string;
  operatorAuth: RequestHandler;
  verifyInternal(req: Request): boolean;
  sessionId(clientId: string): string | undefined;
  ordinaryConversation(id: string): boolean;
  sourceConversation?(id: string): boolean;
  roleSetup?(request: TelosWorkRoleRequest): Promise<unknown>;
  ordinaryRoleSetup?(request: TelosWorkRoleRequest): Promise<unknown>;
  ordinaryRoleSetupReviewed?(request: TelosWorkRoleRequest): Promise<unknown>;
  roleReview?(request: TelosWorkRoleRequest): Promise<unknown>;
  roleSetupReviewed?(request: TelosWorkRoleRequest): Promise<unknown>;
  roleContext?(request: TelosWorkRoleRequest): Promise<unknown>;
  advisorPreview?(request: TelosWorkRoleRequest): Promise<unknown>;
  advisorSave?(request: TelosWorkRoleRequest): Promise<unknown>;
  ordinaryDelegateSlice?(request: TelosWorkRoleRequest): Promise<unknown>;
  delegateSlice?(request: TelosWorkRoleRequest): Promise<unknown>;
  assertRoleAssignment?(itemId: string, role: 'lead' | 'worker', conversationId: string): void;
  /** Denial-only real host fence, called synchronously under the Telos writer
   * transaction. Missing/unknown/busy host state refuses permanent deletion. */
  assertLifecycleQuiescent?(itemId: string, original: TelosWorkStore): void;
}) {
  const router = Router();
  router.use(['/api/telos/work', '/api/internal/telos/work'], (_req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    next();
  });
  const run = (res: Response, action: (store: TelosWorkStore) => unknown, readRecord = false) => {
    let store: TelosWorkStore | undefined;
    try {
      const policy = {
        ordinaryConversation: options.ordinaryConversation,
        sourceConversation: options.sourceConversation,
      };
      store = readRecord
        ? TelosWorkStore.openForRecordRead(options.dbPath(), policy)
        : new TelosWorkStore(options.dbPath(), policy);
      res.json(action(store));
    } catch (error) {
      const known = error instanceof TelosWorkError;
      const constraint =
        error instanceof Error && 'code' in error && error.code === 'SQLITE_CONSTRAINT_TRIGGER';
      const status = known
        ? { not_found: 404, unauthorized: 403, conflict: 409, invalid: 400 }[error.code]
        : constraint
          ? 400
          : error instanceof z.ZodError
            ? 400
            : 503;
      res.status(status).json({
        code: known ? error.code : status === 400 ? 'invalid' : 'unavailable',
        error: known
          ? error.message
          : constraint
            ? 'Invalid work composition'
            : status === 400
              ? 'Invalid work input'
              : 'Telos work service unavailable',
      });
    } finally {
      store?.close();
    }
  };
  const actor = (res: Response): TelosWorkActor | undefined => {
    const id: unknown = res.locals.authSession?.id;
    if (typeof id !== 'string' || !id.trim()) {
      res
        .status(403)
        .json({ code: 'unauthorized', error: 'Interactive operator authentication required' });
      return;
    }
    return { kind: 'operator', id };
  };
  const control = (
    store: TelosWorkStore,
    input: TelosWorkControlCommand,
    authority: TelosWorkActor,
  ) => {
    switch (input.operation) {
      case 'read':
        return store.readControl(input.controlId, authority);
      case 'inbox':
        return store.controlInbox(input.itemId, authority);
      case 'request': {
        const { operation, ...raw } = input;
        void operation;
        return store.requestControl(raw, authority);
      }
      case 'acknowledge': {
        const { operation, ...raw } = input;
        void operation;
        return store.acknowledgeControl(raw, authority);
      }
      case 'release': {
        const { operation, ...raw } = input;
        void operation;
        return store.releaseControl(raw, authority);
      }
    }
  };
  const lifecycleActor = (res: Response) => {
    const authority = actor(res);
    if (!authority) return;
    const auth = res.locals.authSession as AuthSession;
    if (!isAuthSessionCurrent(auth)) {
      res
        .status(403)
        .json({ code: 'unauthorized', error: 'Current interactive operator required' });
      return;
    }
    return authority;
  };
  router.get('/api/telos/work/items/:itemId/lifecycle', options.operatorAuth, (req, res) => {
    const authority = lifecycleActor(res);
    if (!authority) return;
    const id = TelosWorkIdSchema.safeParse(req.params.itemId);
    if (!id.success) {
      res.status(400).json({ code: 'invalid', error: 'Invalid work item ID' });
      return;
    }
    run(res, (store) => store.readLifecycle(id.data, authority));
  });
  router.get('/api/telos/work/lifecycle', options.operatorAuth, (req, res) => {
    const authority = lifecycleActor(res);
    if (!authority) return;
    const view = TelosWorkLifecycleListSchema.safeParse(req.query.view ?? 'active');
    if (!view.success) {
      res.status(400).json({ code: 'invalid', error: 'Invalid lifecycle view' });
      return;
    }
    run(res, (store) => store.listLifecycle(view.data, authority));
  });
  router.post(
    '/api/telos/work/lifecycle',
    options.operatorAuth,
    requireSameOriginJson,
    (req, res) => {
      const authority = lifecycleActor(res);
      if (!authority) return;
      const input = TelosWorkLifecycleCommandSchema.safeParse(req.body);
      if (!input.success) {
        res.status(400).json({ code: 'invalid', error: 'Invalid lifecycle command' });
        return;
      }
      run(res, (store) =>
        store.executeLifecycle(
          input.data,
          authority,
          options.assertLifecycleQuiescent
            ? (itemId) => {
                const result = options.assertLifecycleQuiescent!(itemId, store);
                if (!isAuthSessionCurrent(res.locals.authSession as AuthSession))
                  throw new TelosWorkError(
                    'unauthorized',
                    'Operator authorization expired or was revoked',
                  );
                return result;
              }
            : undefined,
        ),
      );
    },
  );
  router.post(
    '/api/telos/work/controls',
    options.operatorAuth,
    requireSameOriginJson,
    (req, res) => {
      const authority = actor(res);
      if (!authority) return;
      const parsed = TelosWorkControlCommandSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ code: 'invalid', error: 'Invalid scoped control' });
        return;
      }
      run(res, (store) => control(store, parsed.data, authority));
    },
  );
  router.post('/api/internal/telos/work/control', (req, res) => {
    if (!options.verifyInternal(req)) {
      res.status(401).json({ code: 'unauthorized', error: 'Internal token required' });
      return;
    }
    const parsed = z
      .strictObject({
        clientId: TelosWorkIdSchema,
        sessionId: TelosWorkIdSchema,
        input: TelosWorkControlCommandSchema,
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ code: 'invalid', error: 'Invalid scoped control' });
      return;
    }
    const selected = parsed.data;
    if (
      req.headers['x-client-id'] !== selected.clientId ||
      options.sessionId(selected.clientId) !== selected.sessionId ||
      !options.ordinaryConversation(selected.sessionId)
    ) {
      res
        .status(403)
        .json({ code: 'unauthorized', error: 'Exact current ordinary conversation required' });
      return;
    }
    run(res, (store) =>
      control(store, selected.input, { kind: 'conversation', id: selected.sessionId }),
    );
  });
  router.get('/api/telos/work/items/:itemId', options.operatorAuth, (req, res) => {
    const authority = actor(res);
    if (!authority) return;
    const id = TelosWorkIdSchema.safeParse(req.params.itemId);
    if (!id.success) {
      res.status(400).json({ code: 'invalid', error: 'Invalid work item ID' });
      return;
    }
    run(res, (store) => store.read(id.data, authority));
  });
  router.get('/api/telos/work/items/:itemId/record', options.operatorAuth, (req, res) => {
    const authority = actor(res);
    if (!authority) return;
    const id = TelosWorkIdSchema.safeParse(req.params.itemId);
    if (!id.success) {
      res.status(400).json({ code: 'invalid', error: 'Invalid work item ID' });
      return;
    }
    run(res, (store) => store.readRecord(id.data, authority), true);
  });
  router.post('/api/telos/work/commands', options.operatorAuth, (req, res) => {
    const authority = actor(res);
    if (!authority) return;
    const input = TelosWorkCommandSchema.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ code: 'invalid', error: 'Invalid work command' });
      return;
    }
    // A role setup commits only through its context-authorizing host owner.
    if (input.data.operation === 'setup_role') {
      res.status(400).json({ code: 'invalid', error: 'Use ordinary role setup' });
      return;
    }
    if (input.data.operation === 'request_attempt') {
      res.status(400).json({ code: 'invalid', error: 'Use exact delegation' });
      return;
    }
    if (input.data.operation === 'assign') {
      const selected = input.data;
      run(res, (store) => {
        if (!options.assertRoleAssignment)
          throw new TelosWorkError('unauthorized', 'Reviewed ordinary role context required');
        return store.execute(selected, authority, () =>
          options.assertRoleAssignment!(selected.itemId, selected.role, selected.conversationId),
        );
      });
      return;
    }
    run(res, (store) => store.execute(input.data, authority));
  });
  for (const operation of [
    { path: 'roles/setup', host: options.roleSetup },
    { path: 'roles/ordinary/setup', host: options.ordinaryRoleSetup },
    { path: 'roles/ordinary/setup-reviewed', host: options.ordinaryRoleSetupReviewed },
    { path: 'roles/setup-reviewed', host: options.roleSetupReviewed },
    { path: 'roles/context', host: options.roleContext },
    { path: 'roles/review', host: options.roleReview },
    { path: 'advisor/preview', host: options.advisorPreview },
    { path: 'advisor/save', host: options.advisorSave },
    { path: 'delegation/start', host: options.delegateSlice },
    { path: 'delegation/ordinary/start', host: options.ordinaryDelegateSlice },
  ])
    router.post(
      `/api/telos/work/${operation.path}`,
      options.operatorAuth,
      requireSameOriginJson,
      async (req, res) => {
        const authority = actor(res);
        if (!authority) return;
        const host = operation.host;
        const delegation = ['delegation/start', 'delegation/ordinary/start'].includes(
          operation.path,
        );
        if (!host) {
          res.status(503).json({
            code: 'unavailable',
            error: delegation
              ? 'Ordinary work delegation unavailable'
              : 'Ordinary role setup is unavailable for this route',
          });
          return;
        }
        const parsed = delegation
          ? (operation.path === 'delegation/ordinary/start'
              ? TelosOrdinaryWorkDelegationInputSchema
              : TelosWorkDelegationInputSchema
            ).safeParse(req.body)
          : undefined;
        if (parsed && !parsed.success) {
          res.status(400).json({ code: 'invalid', error: 'Invalid work delegation' });
          return;
        }
        const auth = res.locals.authSession as AuthSession;
        const retained = { id: auth.id, expiresAt: auth.expiresAt };
        const controller = new AbortController();
        const cancel = () => controller.abort();
        const unregister = registerAuthSession(retained, cancel);
        const close = () => {
          if (!res.writableEnded) cancel();
        };
        req.once('aborted', cancel);
        res.once('close', close);
        const timer = setTimeout(
          cancel,
          Math.min(120000, Math.max(0, retained.expiresAt - Date.now())),
        );
        const assertAuthorized = () => {
          if (!isAuthSessionCurrent(retained))
            throw new TelosWorkError(
              'unauthorized',
              'Operator authorization expired or was revoked',
            );
          controller.signal.throwIfAborted();
        };
        try {
          assertAuthorized();
          const result = await host({
            actor: authority,
            authorization: retained,
            raw: structuredClone(parsed?.success ? parsed.data : req.body),
            signal: controller.signal,
            assertAuthorized,
          });
          assertAuthorized();
          if (delegation) {
            const receipt = TelosWorkDelegationReceiptSchema.safeParse(result);
            if (!receipt.success) throw new Error('Ordinary delegation receipt unavailable');
            res.json(receipt.data);
          } else res.json(result);
        } catch (error) {
          if (res.destroyed) return;
          const known = error instanceof TelosWorkError;
          const status = !isAuthSessionCurrent(retained)
            ? 403
            : known
              ? { not_found: 404, unauthorized: 403, conflict: 409, invalid: 400 }[error.code]
              : error instanceof z.ZodError
                ? 400
                : 503;
          res.status(status).json({
            ...([
              'roles/setup',
              'roles/setup-reviewed',
              'roles/ordinary/setup',
              'roles/ordinary/setup-reviewed',
            ].includes(operation.path) &&
            status === 409 &&
            known &&
            error.code === 'conflict' &&
            error.recovery
              ? { recovery: error.recovery }
              : {}),
            code:
              status === 403
                ? 'unauthorized'
                : known
                  ? error.code
                  : status === 400
                    ? 'invalid'
                    : 'unavailable',
            error: delegation
              ? delegationError(status)
              : known
                ? error.message
                : status === 403
                  ? 'Operator authorization expired or was revoked'
                  : 'Ordinary role setup unavailable',
          });
        } finally {
          clearTimeout(timer);
          unregister();
          req.off('aborted', cancel);
          res.off('close', close);
        }
      },
    );
  router.post('/api/telos/work/links', options.operatorAuth, (req, res) => {
    const authority = actor(res);
    if (!authority) return;
    const input = TelosSourceConversationReferenceSchema.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ code: 'invalid', error: 'Invalid conversation reference' });
      return;
    }
    run(res, (store) => store.forConversation(input.data, authority));
  });
  router.post('/api/internal/telos/work/read', (req, res) => {
    if (!options.verifyInternal(req)) {
      res.status(401).json({ code: 'unauthorized', error: 'Internal token required' });
      return;
    }
    const id = options.sessionId(String(req.headers['x-client-id'] ?? ''));
    if (!id) {
      res.status(409).json({ code: 'unavailable', error: 'Active Mitzo session required' });
      return;
    }
    const input = z.strictObject({ itemId: TelosWorkIdSchema }).safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ code: 'invalid', error: 'Invalid work read' });
      return;
    }
    run(res, (store) => store.read(input.data.itemId, { kind: 'conversation', id }));
  });
  const internalDelegation = z.strictObject({
    clientId: TelosWorkIdSchema,
    sessionId: TelosWorkIdSchema,
    input: TelosStartSliceInputSchema,
  });
  router.post('/api/internal/telos/work/delegate', async (req, res) => {
    if (!options.verifyInternal(req)) {
      res.status(401).json({ code: 'unauthorized', error: 'Internal token required' });
      return;
    }
    const parsed = internalDelegation.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ code: 'invalid', error: 'Invalid work delegation' });
      return;
    }
    const selected = structuredClone(parsed.data);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const close = () => {
      if (!res.writableEnded) cancel();
    };
    req.once('aborted', cancel);
    res.once('close', close);
    const timer = setTimeout(cancel, 120000);
    const assertAuthorized = () => {
      controller.signal.throwIfAborted();
      if (
        !options.verifyInternal(req) ||
        req.headers['x-client-id'] !== selected.clientId ||
        options.sessionId(selected.clientId) !== selected.sessionId ||
        !options.ordinaryConversation(selected.sessionId)
      )
        throw new TelosWorkError('unauthorized', 'Exact ordinary lead identity required');
    };
    try {
      assertAuthorized();
      if (!options.delegateSlice) {
        res.status(503).json({ code: 'unavailable', error: delegationError(503) });
        return;
      }
      const result = await options.delegateSlice({
        actor: { kind: 'conversation', id: selected.sessionId },
        raw: selected.input,
        signal: controller.signal,
        assertAuthorized,
      });
      assertAuthorized();
      const receipt = TelosWorkDelegationReceiptSchema.safeParse(result);
      if (!receipt.success) throw new Error('Ordinary delegation receipt unavailable');
      res.json(receipt.data);
    } catch (error) {
      if (res.destroyed) return;
      const status =
        error instanceof TelosWorkError
          ? { not_found: 404, unauthorized: 403, conflict: 409, invalid: 400 }[error.code]
          : error instanceof z.ZodError
            ? 400
            : 503;
      res.status(status).json({
        code:
          status === 403
            ? 'unauthorized'
            : status === 404
              ? 'not_found'
              : status === 409
                ? 'conflict'
                : status === 400
                  ? 'invalid'
                  : 'unavailable',
        error: delegationError(status),
      });
    } finally {
      clearTimeout(timer);
      req.off('aborted', cancel);
      res.off('close', close);
    }
  });
  return router;
}

function delegationError(status: number): string {
  return status === 403
    ? 'Work delegation authority unavailable'
    : status === 400
      ? 'Invalid work delegation'
      : status === 404
        ? 'Selected work unavailable'
        : status === 409
          ? 'Work delegation conflicts with retained state'
          : 'Ordinary work delegation unavailable';
}
