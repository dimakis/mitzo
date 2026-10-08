import type { SessionMeta } from './types.js';

/** Provider files and transcript contents never confer conversation ownership. */
export function isRegisteredConversation(
  meta: SessionMeta | null | undefined,
): meta is SessionMeta {
  return Boolean(
    meta &&
    (meta.conversationSource === 'mitzo' ||
      meta.conversationSource === 'external_import' ||
      // Compatibility for pre-registry transports and legacy controller records.
      // EventStore migration freezes this evidence into durable Mitzo ownership.
      ((meta.conversationSource === 'legacy' || meta.conversationSource === undefined) &&
        (meta.isActive ||
          meta.promptCount > 0 ||
          meta.numTurns > 0 ||
          meta.initialPrompt ||
          meta.accountBinding ||
          meta.symposiumConfig))),
  );
}
