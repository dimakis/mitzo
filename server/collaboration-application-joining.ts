import { isDeepStrictEqual } from 'node:util';
import {
  CollaborationContractError,
  type CollaborationJoin,
  type CollaborationSettings,
  type CollaborationSnapshot,
} from '@mitzo/protocol';
import { isAuthSessionCurrent, type AuthSession } from './auth.js';
import { CollaborationApplicationReview } from './collaboration-application-review.js';
import { OrdinaryCollaborationJoining } from './collaboration-joining-owner.js';
import { compileCollaborationContext } from './collaboration-context-compiler.js';
import { createCollaborationContextSource } from './collaboration-context-source.js';
import { ordinaryWorkspaceTaskRoot } from './ordinary-workspace-runtime.js';
import type { EventStore } from './event-store.js';
import type { RepositoryWorkspaces } from './repository-workspaces.js';

/** Authenticated composition of existing review, allocation and membership owners.
 * No provider, command, queue, capacity adapter or separate persistence is created.
 */
export function createApplicationCollaborationJoining(
  owners: { store: EventStore; workspaces: RepositoryWorkspaces },
  auth: AuthSession,
) {
  const reviewOwner = new CollaborationApplicationReview(owners);
  async function authorize(
    operatorId: string,
    group: string,
    reference: Pick<CollaborationSnapshot, 'snapshotId' | 'sha256'>,
    settings: CollaborationSettings,
    signal: AbortSignal,
    join?: CollaborationJoin,
  ) {
    const retained = owners.store.collaborationConversation.getReviewCompilationForSnapshot(
      group,
      reference.snapshotId,
    );
    const snapshot = owners.store.collaborationConversation.getSnapshot(
      group,
      reference.snapshotId,
    );
    const assertCurrent = () => {
      signal.throwIfAborted();
      const source = snapshot && owners.store.getSession(snapshot.sourceConversationId);
      const membership = owners.store.getSessionCollaboration(group);
      if (
        !isAuthSessionCurrent(auth) ||
        operatorId !== auth.id ||
        retained?.operatorId !== auth.id ||
        !snapshot ||
        snapshot.sha256 !== reference.sha256 ||
        retained.settings.length !== 1 ||
        !isDeepStrictEqual(retained.settings[0], settings) ||
        !source ||
        source.isHidden ||
        source.sessionType === 'symposium' ||
        source.symposiumConfig ||
        !membership?.participantSessionIds.includes(snapshot.sourceConversationId)
      )
        throw new CollaborationContractError('snapshot_changed');
    };
    assertCurrent();
    const resolved = await reviewOwner.resolveJoiningSettings(settings, signal, join);
    assertCurrent();
    const source = createCollaborationContextSource({
      store: owners.store,
      authorizeConversation: async () => {
        assertCurrent();
        resolved.assertCurrent();
      },
      assertConversationCurrent: () => {
        assertCurrent();
        resolved.assertCurrent();
      },
    });
    // Reauthorize the original frozen boundary, never today's later transcript.
    const compiled = await compileCollaborationContext(retained!.selection, [settings], source);
    source.assertCurrentAtSave();
    const fields = [
      'sourceConversationId',
      'boundary',
      'mode',
      'purpose',
      'joiningBrief',
      'messages',
      'artifacts',
      'summary',
    ] as const;
    if (fields.some((key) => !isDeepStrictEqual(compiled[key], snapshot![key])))
      throw new CollaborationContractError('snapshot_changed');
    return resolved;
  }
  return new OrdinaryCollaborationJoining({
    ...owners,
    authority: {
      authorizeConfirmation: async ({ operatorId, collaborationId, input, join }, signal) => {
        await authorize(operatorId, collaborationId, input.snapshot, input.settings, signal, join);
      },
      authorizeJoin: async ({ operatorId, collaborationId, join }, signal) => {
        await authorize(operatorId, collaborationId, join.snapshot, join.settings, signal, join);
      },
      authorizeReconciliation: async ({ operatorId, collaborationId, join }, signal) => {
        await authorize(operatorId, collaborationId, join.snapshot, join.settings, signal, join);
      },
    },
    resolvePreparation: async ({ join }, signal) => {
      // The joining owner renews source/operator authority immediately after
      // resolution and before allocation. Do not compile the same source twice.
      const resolved = await reviewOwner.resolveJoiningSettings(join.settings, signal, join);
      return {
        binding: resolved.binding,
        agentProfile: resolved.agentProfile,
        taskRoot: ordinaryWorkspaceTaskRoot(true),
        ...(resolved.sandboxWorkdir ? { sandboxWorkdir: resolved.sandboxWorkdir } : {}),
      };
    },
  });
}
