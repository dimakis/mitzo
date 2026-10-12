/** Frozen review wiring from accepted main 0b81f65f before extraction.
 * Historical differential oracle only; never mounted by production. */
import type { Express } from 'express';
import { registerAuthSession, operatorAuthMiddleware, type AuthSession } from '../../auth.js';
import { custodianRequestAuthority } from '../../symposium-custodian-authority.js';
import { createSymposiumReviewRouter } from '../../symposium-review-routes.js';
import { createSymposiumReviewPublicationPreflight } from '../../symposium-review-publication.js';
import type { SymposiumReviewRouteHost } from '../../symposium-review-host-contract.js';
import type { SymposiumReviewStore } from '../../symposium-review-workflows.js';
import type { SymposiumReviewActionAuthority } from '../../symposium-review-action-authority.js';

export function mountReviewCompositionBeforeExtraction(
  app: Express,
  deps: {
    store: SymposiumReviewStore;
    actionAuthority: SymposiumReviewActionAuthority;
    currentHost(): SymposiumReviewRouteHost | undefined;
    runtime(sessionId: string): object | null;
    hasSession(sessionId: string): boolean;
  },
) {
  const holder = {
    get host() {
      return deps.currentHost();
    },
  };
  app.use(
    '/api/sessions/:id/symposium/reviews',
    operatorAuthMiddleware,
    createSymposiumReviewRouter({
      store: deps.store,
      authorizeContext(req, res, context) {
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
          release = deps.actionAuthority.bind(
            context,
            String(req.body?.action ?? ''),
            assertCurrent,
          );
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
      },
      getPublicationPreflight: (sessionId) =>
        holder.host?.reviewHost && holder.host.reviewPublication && deps.runtime(sessionId)
          ? createSymposiumReviewPublicationPreflight({
              ...holder.host.reviewPublication,
              store: deps.store,
            })
          : null,
      hasSession: deps.hasSession,
      getHost: (sessionId) =>
        holder.host?.reviewHost && deps.runtime(sessionId) ? holder.host.reviewHost : null,
    }),
  );
}
