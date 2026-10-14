import type { Express } from 'express';
import { AccountBindingSchema } from '@mitzo/protocol';
import type { AccountProfiles } from './account-profiles.js';
import { operatorAuthMiddleware } from './auth.js';
import type { EventStore } from './event-store.js';
import type { SessionRegistry } from './session-registry.js';
import {
  createSymposiumDirectorRouter,
  type SymposiumDirectorRouteDeps,
} from './symposium-director-routes.js';
import type { SymposiumHostGrants } from './symposium-host-grants.js';
import { getSymposiumPerspective, getSymposiumQueuedInputs } from './symposium-perspectives.js';

/** App owns stores, grants, registry and runtime/host installation. This owner
 * adapts those borrowed inputs for the Director at its existing mount position.
 * Mutable host, account and runtime inputs stay request-time lookups. */
export interface SymposiumDirectorCompositionDependencies {
  store: EventStore;
  currentHost(): { artifactReady?: SymposiumDirectorRouteDeps['artifactReady'] } | undefined;
  currentAccounts(): Pick<AccountProfiles, 'resolve' | 'validateModel'>;
  runtime: SymposiumDirectorRouteDeps['getRuntime'];
  safetyOrchestrator: ReturnType<SymposiumDirectorRouteDeps['getSafetyOrchestrator']>;
  registry: Pick<SessionRegistry, 'findBySessionId' | 'isActive'>;
  grants: Pick<SymposiumHostGrants, 'validateActiveConfig' | 'activate' | 'reviseSeat'>;
}

export function mountSymposiumDirectorRoutes(
  app: Express,
  deps: SymposiumDirectorCompositionDependencies,
): void {
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
