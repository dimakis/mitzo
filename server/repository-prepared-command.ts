import { isDeepStrictEqual } from 'node:util';
import type { EventStore } from './event-store.js';
import type { RepositoryWorkspaces } from './repository-workspaces.js';

/** A routing hint for the retained V1 owner, never a cold continuation grant. */
export async function repositoryPreparedCommandStatus(options: {
  events: EventStore;
  workspaces(): RepositoryWorkspaces;
  sessionId: string;
  signal: AbortSignal;
  assertCurrent(): void;
}): Promise<{ prepared: boolean; reason?: string }> {
  const { events, sessionId, signal } = options;
  if (!events.getSession(sessionId)?.repositoryWorkspaceId) return { prepared: false };
  try {
    const read = () => {
      signal.throwIfAborted();
      // Started or uncertain commands belong to the existing continuation owner.
      if (
        events.getOrdinaryInitialCommandId(sessionId) ||
        events.hasUncertainOrdinaryCommand(sessionId)
      )
        return null;
      const current = events.getSession(sessionId);
      const route = events.getSessionRuntimeBinding(sessionId);
      if (
        (route &&
          (route.harness.implementation !== 'codex' ||
            route.execution.location !== 'local' ||
            route.account.provider !== 'openai-codex')) ||
        (!route && current?.accountBinding?.provider !== 'openai-codex')
      )
        return null;
      // Missing binding for an apparent Local Codex preparation still refuses.
      // Re-read after the original operator check; classification is no grant.
      options.assertCurrent();
      const meta = events.getSession(sessionId);
      const receipt = events.getOrdinarySessionPreparationForConversation(sessionId);
      const binding = events.getSessionRuntimeBinding(sessionId);
      if (
        !meta ||
        !receipt ||
        !binding ||
        !meta.accountBinding ||
        meta.isHidden ||
        meta.ordinaryWorkspaceId != null ||
        meta.sessionType === 'symposium' ||
        meta.symposiumConfig ||
        meta.conversationSource === 'external_import' ||
        receipt.firstCommandId !== null ||
        meta.repositoryWorkspaceId !== receipt.workspaceId ||
        receipt.sessionId !== sessionId ||
        binding.harness.implementation !== 'codex' ||
        binding.execution.location !== 'local' ||
        binding.account.provider !== 'openai-codex' ||
        !isDeepStrictEqual(binding, receipt.settings.binding) ||
        meta.selectedModel !== receipt.settings.selection.model ||
        (meta.reasoningEffort ?? null) !== receipt.settings.selection.thinking ||
        meta.mode !== receipt.settings.selection.permission.mode ||
        !meta.agentProfile ||
        !isDeepStrictEqual(
          {
            profileId: meta.agentProfile.profileId,
            revision: meta.agentProfile.revision,
            ...(meta.agentProfile.kind ? { kind: meta.agentProfile.kind } : {}),
          },
          receipt.settings.selection.agent,
        )
      )
        throw Error('Original repository preparation unavailable');
      return { receipt, meta };
    };
    const original = read();
    if (!original) return { prepared: false };
    const owner = options.workspaces();
    const record = owner.get(original.receipt.workspaceId);
    if (
      original.meta.cwd !== record.directory ||
      !isDeepStrictEqual(original.meta.accountBinding, record.binding)
    )
      throw Error('Original repository identity unavailable');
    await owner.qualifyPreparedHostSession(original.receipt, original.meta.accountBinding!, signal);
    if (!isDeepStrictEqual(original, read()))
      throw Error('Repository preparation changed during qualification');
    return { prepared: true };
  } catch {
    return {
      prepared: false,
      reason:
        'This conversation’s original repository or execution choices are unavailable. Preserve its settings and files, then retry to check again.',
    };
  }
}
