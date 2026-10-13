/** Frozen mount contract from accepted main 481a1ab4. Test oracle only. */
import type { Express } from 'express';
import { operatorAuthMiddleware } from '../../auth.js';
import { createPublicationRouter } from '../../symposium-publication-routes.js';
import { createSymposiumReviewRouteComposition } from '../../symposium-review-route-composition.js';
import { createSymposiumSourceRouter } from '../../symposium-source-routes.js';
import type { SymposiumArtifactRouteDependencies } from '../../symposium-artifact-route-composition.js';

export function mountArtifactRoutesBeforeExtraction(
  app: Express,
  deps: SymposiumArtifactRouteDependencies,
) {
  app.use(
    '/api/sessions/:id/symposium/publication',
    operatorAuthMiddleware,
    createPublicationRouter({
      ...deps.publication,
      hasSession: (id) => deps.events.getSession(id)?.sessionType === 'symposium',
    }),
  );
  app.use(
    '/api/sessions/:id/symposium/reviews',
    createSymposiumReviewRouteComposition({
      ...deps.reviews,
      currentHost: () => deps.currentHost(),
      hasSession: (id) => deps.events.getSession(id)?.sessionType === 'symposium',
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
