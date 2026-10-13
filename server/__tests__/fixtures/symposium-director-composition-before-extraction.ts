/** Frozen Director mount from accepted d22192b0, with app-owned inputs parameterized.
 * This is a test oracle, not another application entry point. */
import type { Express } from 'express';
import { AccountBindingSchema } from '@mitzo/protocol';
import { operatorAuthMiddleware } from '../../auth.js';
import { createSymposiumDirectorRouter } from '../../symposium-director-routes.js';
import { getSymposiumPerspective, getSymposiumQueuedInputs } from '../../symposium-perspectives.js';
import type { SymposiumDirectorCompositionDependencies } from '../../symposium-director-route-composition.js';

export function mountDirectorBeforeExtraction(
  app: Express,
  deps: SymposiumDirectorCompositionDependencies,
) {
  app.use(
    '/api/sessions/:id/symposium',
    operatorAuthMiddleware,
    createSymposiumDirectorRouter({
      store: deps.store,
      artifactReady: (sessionId, seatId, generation) =>
        deps.currentHost()?.artifactReady?.(sessionId, seatId, generation) ?? true,
      getRuntime: (sessionId) => deps.runtime(sessionId),
      getSafetyOrchestrator: () => deps.safetyOrchestrator,
      profileBindingEnforced: true,
      hasOrdinaryRuntime: (sessionId) => {
        const found = deps.registry.findBySessionId(sessionId);
        return Boolean(found && deps.registry.isActive(found.clientId));
      },
      validateSelection: (seat) => {
        if (seat.accountBinding)
          deps
            .currentAccounts()
            .validateModel(seat.accountBinding, seat.model, seat.reasoningEffort);
      },
      validateActiveConfig: (sessionId, config) =>
        deps.grants.validateActiveConfig(sessionId, config),
      activateDraft: (input) => deps.grants.activate(input),
      reviseSeat: (input) => deps.grants.reviseSeat(input),
      getPerspective: (sessionId, perspective, options) =>
        getSymposiumPerspective(deps.store, sessionId, perspective, options),
      getQueuedInputs: (sessionId, perspective) =>
        getSymposiumQueuedInputs(deps.store, sessionId, perspective),
      resolveSelection: (accountId, model, reasoningEffort) => {
        const profiles = deps.currentAccounts();
        const binding = profiles.resolve(accountId, model);
        profiles.validateModel(binding, model, reasoningEffort);
        return AccountBindingSchema.parse(binding);
      },
    }),
  );
}
