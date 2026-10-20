import { isDeepStrictEqual } from 'node:util';
import type { EventStore } from './event-store.js';
import type { RepositoryWorkspaces } from './repository-workspaces.js';
import { SessionArtifactUnavailableError } from './session-artifact-reader.js';

type Reader = Pick<
  EventStore,
  | 'getSession'
  | 'getSessionRuntimeBinding'
  | 'getOrdinaryWorkspaceSessionPreparation'
  | 'getOrdinaryWorkspaceSessionPreparationForConversation'
>;
/** Retained V2 preparation keeps its scope even when metadata is partly restored. */
export function hasOrdinaryWorkspaceArtifactScope(
  events: Reader,
  sessionId: string | undefined,
): boolean {
  if (!sessionId) return false;
  try {
    return (
      events.getSession(sessionId)?.ordinaryWorkspaceId != null ||
      !!events.getOrdinaryWorkspaceSessionPreparationForConversation(sessionId)
    );
  } catch {
    return true;
  } // An unreadable identity cannot grant configured-path fallback.
}

/** Read-only file authority from the original custody owner, never session cwd alone. */
export function ordinaryWorkspaceArtifactRoot(
  events: Reader,
  workspaces: () => RepositoryWorkspaces,
  sessionId: string | undefined,
): { workspaceId: string; root: string } | null {
  const meta = sessionId ? events.getSession(sessionId) : null;
  if (!hasOrdinaryWorkspaceArtifactScope(events, sessionId)) return null;
  const unavailable = () =>
    new SessionArtifactUnavailableError(
      'This conversation’s workspace is unavailable. Preserve its existing files and recover the original conversation.',
    );
  try {
    if (!meta) throw unavailable();
    const owner = workspaces();
    const record = owner.getOrdinaryWorkspaceForConversation(meta.sessionId);
    const receipt =
      record && events.getOrdinaryWorkspaceSessionPreparation(record.allocationOperationId);
    const runtime = events.getSessionRuntimeBinding(meta.sessionId);
    const account = meta.accountBinding;
    if (
      !record ||
      !receipt ||
      !account ||
      meta.isHidden ||
      meta.repositoryWorkspaceId != null ||
      meta.sessionType === 'symposium' ||
      meta.conversationSource === 'external_import' ||
      record.id !== meta.ordinaryWorkspaceId ||
      record.conversationId !== meta.sessionId ||
      record.directory !== meta.cwd ||
      receipt.sessionId !== meta.sessionId ||
      receipt.workspaceId !== record.id ||
      receipt.preparationFingerprint !== record.preparationFingerprint ||
      !isDeepStrictEqual(receipt.settings, record.settings) ||
      !isDeepStrictEqual(runtime, record.settings.binding) ||
      account.accountId !== record.binding.accountId ||
      account.provider !== record.binding.provider ||
      account.profileRevision !== record.binding.profileRevision
    )
      throw unavailable();
    owner.validateRetainedOrdinaryWorkspace(meta.sessionId);
    if (record.state === 'reserved')
      throw new SessionArtifactUnavailableError(
        'Files will be available after the first message starts this conversation.',
      );
    const claimed = owner.validateOrdinaryWorkspace(meta.sessionId, record.directory);
    return { workspaceId: claimed.id, root: claimed.directory };
  } catch (error) {
    if (error instanceof SessionArtifactUnavailableError) throw error;
    throw unavailable();
  }
}
