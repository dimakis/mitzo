import { Router, type Request, type Response } from 'express';
import {
  operatorAuthMiddleware,
  registerAuthSession,
  type AuthSession,
} from './operator-session.js';
import { custodianRequestAuthority } from './symposium-custodian-authority.js';
import type { SymposiumReviewActionAuthority } from './symposium-review-action-authority.js';
import type { ReviewContext } from './symposium-review-coordinator.js';
import type { SymposiumReviewRouteHost } from './symposium-review-host-contract.js';
import { createSymposiumReviewRouter } from './symposium-review-routes.js';
import { createSymposiumReviewPublicationPreflight } from './symposium-review-publication.js';
import type { SymposiumReviewStore } from './symposium-review-workflows.js';

/** Binds only an authenticated, live request to the existing action authority.
 * Finishing or closing the response releases both capability and auth listener. */
export function createSymposiumReviewRequestAuthorizer(authority: SymposiumReviewActionAuthority) {
  return (req: Request, res: Response, context: ReviewContext): ReviewContext => {
    const session = res.locals.authSession as AuthSession | undefined;
    if (!session) throw new Error('Interactive authorization required');
    const retained = custodianRequestAuthority(req);
    let current = true;
    const unregister = registerAuthSession(session, () => {
      current = false;
    });
    const assertCurrent = () => {
      if (!current || res.writableEnded || session.expiresAt <= Date.now())
        throw new Error('Review request authorization expired');
      if (retained && custodianRequestAuthority(req)?.id !== retained.id)
        throw new Error('Custodian review request authority changed');
    };
    let release: (() => void) | undefined;
    try {
      release = authority.bind(context, String(req.body?.action ?? ''), assertCurrent);
    } catch (error) {
      unregister();
      throw error;
    }
    const close = () => {
      current = false;
      release?.();
      unregister();
    };
    res.once('close', close);
    res.once('finish', close);
    return context;
  };
}

/** App retains host installation, stores and runtime ownership. Resolve trusted
 * capabilities at the same request-time seams as the original composition. */
export function createSymposiumReviewRouteComposition(deps: {
  store: SymposiumReviewStore;
  actionAuthority: SymposiumReviewActionAuthority;
  currentHost(): SymposiumReviewRouteHost | undefined;
  runtime(sessionId: string): object | null;
  hasSession(sessionId: string): boolean;
}): Router {
  const router = Router({ mergeParams: true });
  router.use(
    operatorAuthMiddleware,
    createSymposiumReviewRouter({
      store: deps.store,
      authorizeContext: createSymposiumReviewRequestAuthorizer(deps.actionAuthority),
      getPublicationPreflight: (sessionId) =>
        deps.currentHost()?.reviewHost &&
        deps.currentHost()?.reviewPublication &&
        deps.runtime(sessionId)
          ? createSymposiumReviewPublicationPreflight({
              ...deps.currentHost()!.reviewPublication!,
              store: deps.store,
            })
          : null,
      hasSession: deps.hasSession,
      getHost: (sessionId) =>
        deps.currentHost()?.reviewHost && deps.runtime(sessionId)
          ? deps.currentHost()!.reviewHost!
          : null,
    }),
  );
  return router;
}
