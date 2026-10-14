import type { EventStore } from './event-store.js';

/** Safe logical routing metadata; carries no login subject, native paths or authority. */
export function ownedLocalCodexMetadata(
  store: Pick<EventStore, 'getSessionRuntimeBinding'>,
  sessionId: string,
  conversationAvailable = false,
) {
  const runtimeBinding = store.getSessionRuntimeBinding(sessionId);
  if (!runtimeBinding) return {};
  return {
    runtimeBinding,
    ...((runtimeBinding.execution.location === 'local' || conversationAvailable) &&
    ['codex', 'responses', 'gemini', 'claude-sdk'].includes(runtimeBinding.harness.implementation)
      ? {
          runtimeCommandScope: conversationAvailable
            ? ('conversation' as const)
            : ('first-command-only' as const),
        }
      : {}),
  };
}
