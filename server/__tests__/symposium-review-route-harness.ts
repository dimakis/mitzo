/** Hermetic request authority only; all workflow methods resolve the current real store.
 * This deliberately imports neither app.ts nor the global authentication bootstrap. */
import express from 'express';
import { randomUUID } from 'node:crypto';
import { dispatchCustodianHttp } from '../symposium-custodian-http.js';
import { selectCustodianOperation } from '../symposium-custodian-protocol.js';
import { custodianRequestAuthority } from '../symposium-custodian-authority.js';
import type { Request, Response } from 'express';
import type { ReviewContext } from '../symposium-review-coordinator.js';
import { createSymposiumReviewRouter } from '../symposium-review-routes.js';
import type { SymposiumInteractiveReviewHost } from '../symposium-review-routes.js';
import type { SymposiumReviewStore } from '../symposium-review-workflows.js';
import type { SymposiumReviewActionAuthority } from '../symposium-review-action-authority.js';

export function bindReviewRouteRequestAuthority(
  req: Request,
  res: Response,
  context: ReviewContext,
  authority: SymposiumReviewActionAuthority,
) {
  const session = res.locals.authSession as { id: string; expiresAt: number };
  const retained = custodianRequestAuthority(req);
  let current = true;
  const release = authority.bind(context, String(req.body?.action ?? ''), () => {
    // Mirrors app.ts request authority. Semantic finish/close expires this
    // context; exact retained-binding release also fences reuse without an HTTP flush.
    if (
      !current ||
      res.writableEnded ||
      session.expiresAt <= Date.now() ||
      !retained ||
      custodianRequestAuthority(req)?.id !== retained.id
    )
      throw Error('Fixture request authority expired');
  });
  const close = () => {
    current = false;
    release();
  };
  res.once('close', close);
  res.once('finish', close);
  return context;
}

export function createReviewRouteHarness(deps: {
  sessionId: string;
  store(): SymposiumReviewStore;
  host(): SymposiumInteractiveReviewHost | null;
  hasSession(sessionId: string): boolean;
  authorize?(req: Request, res: Response, context: ReviewContext): ReviewContext;
}) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const authority = custodianRequestAuthority(req);
    if (authority?.id === 'offline-request-authority') res.locals.authSession = authority;
    next();
  });
  const currentStore = new Proxy(deps.store(), {
    get(_target, key) {
      const current = deps.store();
      const value = Reflect.get(current, key);
      return typeof value === 'function' ? value.bind(current) : value;
    },
  });
  app.use(
    '/api/sessions/:id/symposium/reviews',
    createSymposiumReviewRouter({
      store: currentStore,
      getHost: () => deps.host(),
      hasSession: deps.hasSession,
      authorizeContext: deps.authorize,
      // No publication authority is invented by this fixture.
      getPublicationPreflight: () => null,
    }),
  );
  const base = `/api/sessions/${encodeURIComponent(deps.sessionId)}/symposium/reviews`;
  let revoked = false;
  const send = (
    method: string,
    path: string,
    body: Record<string, unknown> = {},
    authenticated = true,
  ) => {
    const selection = selectCustodianOperation(method, path);
    if (!selection) throw Error('Unsupported fixture route');
    let active = true;
    const expiresAt = Date.now() + 60_000;
    return dispatchCustodianHttp(
      app,
      {
        ...selection,
        epoch: 1,
        requestId: randomUUID(),
        body,
        query: {},
        authorization: {
          id: authenticated ? 'offline-request-authority' : 'missing-operator',
          expiresAt,
        },
      },
      () => {
        if (!active || revoked || expiresAt <= Date.now())
          throw Error('Fixture request authority expired or revoked');
      },
    ).finally(() => {
      active = false;
    });
  };
  return {
    app,
    send,
    revoke() {
      revoked = true;
    },
    get(path = '') {
      return send('GET', base + path);
    },
    post(path: string, body: Record<string, unknown>) {
      return send('POST', base + path, body);
    },
  };
}
