import type { EventStore } from './event-store.js';

/** Safe logical routing metadata; carries no login subject, native paths or authority. */
export function ownedLocalCodexMetadata(
  store: Pick<EventStore, 'getSessionRuntimeBinding'>,
  sessionId: string,
) {
  const runtimeBinding = store.getSessionRuntimeBinding(sessionId);
  if (!runtimeBinding) return {};
  return {
    runtimeBinding,
    ...(runtimeBinding.execution.location === 'local' &&
    runtimeBinding.harness.implementation === 'codex'
      ? { runtimeCommandScope: 'first-command-only' as const }
      : {}),
  };
}
