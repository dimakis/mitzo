import type { Express } from 'express';
import type { EventStore } from './event-store.js';
import { operatorAuthMiddleware } from './auth.js';
import { createPublicationRouter } from './symposium-publication-routes.js';
import { createSymposiumReviewRouteComposition } from './symposium-review-route-composition.js';
import type { SymposiumReviewRouteHost } from './symposium-review-host-contract.js';
import { createSymposiumSourceRouter } from './symposium-source-routes.js';

type PublicationDependencies = Parameters<typeof createPublicationRouter>[0];
type ReviewDependencies = Parameters<typeof createSymposiumReviewRouteComposition>[0];
type SourceDependencies = Parameters<typeof createSymposiumSourceRouter>[0];

/** App keeps store, host installation and runtime lifetimes. This owner mounts
 * the artifact family at its existing position, after ordinary publication and
 * before the Director, without introducing another router or capturing a host. */
export interface SymposiumArtifactRouteDependencies {
  events: Pick<EventStore, 'getSession'>;
  publication: Omit<PublicationDependencies, 'hasSession'>;
  reviews: Pick<ReviewDependencies, 'store' | 'actionAuthority' | 'runtime'>;
  currentHost():
    | (SymposiumReviewRouteHost & { sourceImport?: ReturnType<SourceDependencies['getHost']> })
    | undefined;
  repositories: SourceDependencies['repositories'];
}

export function mountSymposiumArtifactRoutes(
  app: Express,
  deps: SymposiumArtifactRouteDependencies,
): void {
  const hasSession = (id: string) => deps.events.getSession(id)?.sessionType === 'symposium';
  app.use(
    '/api/sessions/:id/symposium/publication',
    operatorAuthMiddleware,
    createPublicationRouter({ ...deps.publication, hasSession }),
  );
  // Reviews own their operator middleware and live request-action authority.
  app.use(
    '/api/sessions/:id/symposium/reviews',
    createSymposiumReviewRouteComposition({
      ...deps.reviews,
      currentHost: () => deps.currentHost(),
      hasSession,
    }),
  );
  app.use(
    '/api/sessions/:id/symposium/source',
    operatorAuthMiddleware,
    createSymposiumSourceRouter({
      repositories: () => deps.repositories(),
      getSession: (id) => deps.events.getSession(id),
      getHost: () => deps.currentHost()?.sourceImport,
    }),
  );
}
