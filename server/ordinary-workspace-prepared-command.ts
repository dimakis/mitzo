import { isDeepStrictEqual } from 'node:util';
import type { EventStore } from './event-store.js';
import type { RepositoryWorkspaces } from './repository-workspaces.js';
import { hasOrdinaryWorkspaceArtifactScope } from './ordinary-workspace-artifact-root.js';

/** Read-only eligibility hint. Actual first-command admission retains all authority. */
export async function ordinaryWorkspacePreparedCommandStatus(options: {
  events: EventStore;
  workspaces(): RepositoryWorkspaces;
  sessionId: string;
  signal: AbortSignal;
  assertCurrent(): void;
}): Promise<{ prepared: boolean; reason?: string }> {
  const { events, sessionId, signal } = options;
  if (!hasOrdinaryWorkspaceArtifactScope(events, sessionId)) return { prepared: false };
  const unavailable = () => Error('Original ordinary workspace preparation unavailable');
  try {
    const owner = options.workspaces();
    const read = () => {
      signal.throwIfAborted();
      options.assertCurrent();
      if (
        events.getOrdinaryInitialCommandId(sessionId) ||
        events.hasUncertainOrdinaryCommand(sessionId)
      )
        return null;
      const meta = events.getSession(sessionId);
      const record = owner.validateRetainedOrdinaryWorkspace(sessionId);
      const receipt = events.getOrdinaryWorkspaceSessionPreparationForConversation(sessionId);
      if (
        !meta ||
        !receipt ||
        !meta.accountBinding ||
        meta.isHidden ||
        meta.repositoryWorkspaceId != null ||
        meta.sessionType === 'symposium' ||
        meta.symposiumConfig ||
        meta.conversationSource === 'external_import' ||
        meta.ordinaryWorkspaceId !== record.id ||
        meta.cwd !== record.directory ||
        receipt.workspaceId !== record.id ||
        receipt.allocationOperationId !== record.allocationOperationId ||
        receipt.preparationFingerprint !== record.preparationFingerprint ||
        receipt.firstCommandId !== null ||
        !isDeepStrictEqual(receipt.settings, record.settings) ||
        !isDeepStrictEqual(events.getSessionRuntimeBinding(sessionId), record.settings.binding) ||
        !isDeepStrictEqual(meta.accountBinding, record.binding) ||
        !isDeepStrictEqual(meta.agentProfile, record.agentProfile) ||
        meta.mode !== record.settings.selection.permission.mode ||
        meta.selectedModel !== record.settings.selection.model ||
        (meta.reasoningEffort ?? null) !== record.settings.selection.thinking
      )
        throw unavailable();
      return record;
    };
    const original = read();
    if (!original) return { prepared: false };
    await owner.qualifyOrdinaryWorkspace({
      preparationId: original.preparationId,
      binding: original.binding,
      settings: original.settings,
      agentProfile: original.agentProfile,
      requiredCapabilities: [
        'ordinary_conversation',
        'writable_files',
        'retained_artifacts',
        'task_execution',
      ],
      signal,
    });
    const current = read();
    if (!isDeepStrictEqual(original, current)) throw unavailable();
    return { prepared: true };
  } catch {
    return {
      prepared: false,
      reason:
        'This conversation’s original workspace or execution choices are unavailable. Preserve its settings and files, then retry to check again.',
    };
  }
}
