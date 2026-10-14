import {
  OrdinaryLocalVertexTarget,
  localVertexCapabilities,
} from './ordinary-local-vertex-capabilities.js';
import { canResumeOwnedLocalVertexDriver } from './ordinary-local-vertex-entry.js';
import {
  OrdinaryLocalResponsesTarget,
  localResponsesCapabilities,
} from './ordinary-local-responses-capabilities.js';
import { isDeepStrictEqual } from 'node:util';
import {
  eventStore,
  registry,
  canResumeOwnedLocalCodexDriver,
  canResumeOwnedLocalResponsesDriver,
} from './chat.js';
import { canResumeOwnedOpenShellCodexDriver } from './ordinary-openshell-codex-entry.js';
import { loadAccountProfiles } from './account-profiles.js';
import {
  loadOrdinaryLocalCodexTarget,
  OrdinaryLocalCodexCapabilityCatalog,
} from './ordinary-local-codex-capabilities.js';
import { loadOrdinaryOpenShellCodexTarget } from './ordinary-openshell-codex-entry-owner.js';
import { projectOrdinaryOpenShellCodexCapabilities } from './ordinary-openshell-codex-route.js';
import { resolveOrdinarySessionRuntime } from './ordinary-session-runtime.js';
import { custodianControllerMode, custodianOwnerMode } from './symposium-custodian-mode.js';

/** Read-only action support; dispatch always requalifies the original authority. */
export function ordinaryCodexContinuationStatus(
  sessionId: string,
  authSessionId?: string,
): { available: boolean; reason?: string } {
  const blocked = (reason: string) => ({ available: false, reason });
  try {
    const meta = eventStore.getSession(sessionId);
    const binding = eventStore.getSessionRuntimeBinding(sessionId);
    if (
      !binding ||
      binding.version !== 2 ||
      !['codex', 'responses', 'claude-sdk', 'gemini'].includes(binding.harness.implementation) ||
      !meta
    )
      return { available: false };
    if (eventStore.hasUncertainOrdinaryCommand(sessionId))
      return blocked(
        'A previous command has an unconfirmed dispatch. Its original receipt and workspace are retained.',
      );
    const location = binding.execution.location;
    if (
      custodianControllerMode ||
      custodianOwnerMode ||
      (location === 'local'
        ? binding.harness.implementation === 'claude-sdk'
          ? process.env.MITZO_ORDINARY_LOCAL_VERTEX_ENABLED
          : binding.harness.implementation === 'gemini'
            ? process.env.MITZO_ORDINARY_LOCAL_GEMINI_ENABLED
            : binding.harness.implementation === 'responses'
              ? process.env.MITZO_ORDINARY_LOCAL_RESPONSES_ENABLED
              : process.env.MITZO_ORDINARY_LOCAL_CODEX_ENABLED
        : process.env.MITZO_ORDINARY_OPENSHELL_CODEX_ENABLED) !== '1'
    )
      return blocked('This conversation’s execution route is not enabled.');
    const profiles = loadAccountProfiles();
    let resolved;
    const request = {
      account: binding.account,
      harness: binding.harness.implementation,
      targetId: binding.execution.targetId,
      mode: meta.mode,
    };
    if (binding.harness.implementation === 'claude-sdk')
      resolved = localVertexCapabilities(profiles, new OrdinaryLocalVertexTarget()).resolve(
        request,
      );
    else if (['responses', 'gemini'].includes(binding.harness.implementation))
      resolved = localResponsesCapabilities(
        profiles,
        new OrdinaryLocalResponsesTarget(
          process.env,
          binding.harness.implementation === 'gemini' ? 'gemini' : 'responses',
        ),
      ).resolve(request);
    else if (location === 'local')
      resolved = new OrdinaryLocalCodexCapabilityCatalog(
        profiles,
        loadOrdinaryLocalCodexTarget(),
        'ordinary',
      ).resolve(request);
    else {
      const target = loadOrdinaryOpenShellCodexTarget();
      if (!target) return blocked('The original OpenShell target is unavailable.');
      const projection = projectOrdinaryOpenShellCodexCapabilities({
        profiles,
        target: target.target,
        deployment: 'ordinary',
      });
      resolved = resolveOrdinarySessionRuntime(request, projection.catalog);
    }
    if (resolved.status !== 'compatible' || !isDeepStrictEqual(resolved.binding, binding))
      return blocked('The original account or execution configuration has changed.');
    if (!authSessionId)
      return blocked('Sign in with the original login to resume this conversation.');
    const live = registry.findBySessionId(sessionId)?.session;
    if (live)
      return live.ordinaryRuntimeOwner?.authSessionId === authSessionId &&
        live.ordinaryRuntimeOwner.location === location
        ? { available: true }
        : blocked('This conversation belongs to another login.');
    if (
      ['responses', 'claude-sdk', 'gemini'].includes(binding.harness.implementation) &&
      meta.executionPhase &&
      meta.executionPhase !== 'TERMINAL'
    )
      return blocked(
        'The previous API turn has an unconfirmed outcome. Its original command and history are retained.',
      );
    const resumable =
      location === 'local'
        ? binding.harness.implementation === 'claude-sdk'
          ? canResumeOwnedLocalVertexDriver(sessionId, authSessionId)
          : ['responses', 'gemini'].includes(binding.harness.implementation)
            ? canResumeOwnedLocalResponsesDriver(sessionId, authSessionId)
            : canResumeOwnedLocalCodexDriver(sessionId, authSessionId)
        : canResumeOwnedOpenShellCodexDriver(sessionId, authSessionId);
    return resumable
      ? { available: true }
      : blocked(
          'The original runtime custody is unavailable. The saved conversation and workspace are retained.',
        );
  } catch {
    return blocked('The original execution route is unavailable. Retry to check again.');
  }
}
