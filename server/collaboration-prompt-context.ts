import { isDeepStrictEqual } from 'node:util';
import {
  CollaborationContractError,
  type CollaborationSnapshot,
  type CollaborationSettings,
} from '@mitzo/protocol';
import { isAuthSessionCurrent, type AuthSession } from './auth.js';
import type { EventStore } from './event-store.js';
import { createCollaborationContextSource } from './collaboration-context-source.js';
import { compileCollaborationContext } from './collaboration-context-compiler.js';
import { ordinaryOperatorOwnsConversation } from './ordinary-operator-identity.js';
import { snapshotMaterial } from './collaboration-context-input.js';
export { snapshotMaterial } from './collaboration-context-input.js';

export type PreparedPromptContext = {
  snapshot: CollaborationSnapshot;
  assertRecipient(sessionId: string, settings: CollaborationSettings): void;
  assertCurrent(): void;
};
export type PreparedPromptContexts = Map<string, PreparedPromptContext>;

/** Existing source compiler + ordinary retained settings. This is a renewed
 * context capability only; it cannot dispatch or acknowledge any command. */
export async function preparePromptContext(options: {
  store: EventStore;
  auth: AuthSession;
  group: string;
  reference: { snapshotId: string; sha256: string };
  signal: AbortSignal;
}): Promise<PreparedPromptContext> {
  const { store, auth, group, reference, signal } = options;
  const snapshot = store.collaborationConversation.getSnapshot(group, reference.snapshotId);
  const retained = store.collaborationConversation.getReviewCompilationForSnapshot(
    group,
    reference.snapshotId,
  );
  const audience = retained?.promptAudience;
  const assertCurrent = () => {
    signal.throwIfAborted();
    if (
      !isAuthSessionCurrent(auth) ||
      !snapshot ||
      snapshot.sha256 !== reference.sha256 ||
      !retained ||
      !ordinaryOperatorOwnsConversation(retained.operatorId, auth.id) ||
      !audience ||
      audience.sessionIds.length !== retained.settings.length
    )
      throw new CollaborationContractError('snapshot_changed');
    store.collaborationConversation.assertCurrentSnapshotSource(group, snapshot.snapshotId);
    const source = store.getSession(snapshot.sourceConversationId);
    if (!source || source.isHidden || source.sessionType === 'symposium' || source.symposiumConfig)
      throw new CollaborationContractError('snapshot_changed');
  };
  assertCurrent();
  const source = createCollaborationContextSource({
    store,
    authorizeConversation: async () => assertCurrent(),
    assertConversationCurrent: assertCurrent,
  });
  const compiled = await compileCollaborationContext(
    retained!.selection,
    retained!.settings,
    source,
  );
  if (
    !isDeepStrictEqual(snapshotMaterial(compiled), snapshotMaterial(snapshot!)) ||
    compiled.mode !== snapshot!.mode
  )
    throw new CollaborationContractError('snapshot_changed');
  return {
    snapshot: snapshot!,
    assertCurrent: () => {
      assertCurrent();
      source.assertCurrentAtSave();
    },
    assertRecipient: (id, settings) => {
      assertCurrent();
      const index = audience!.sessionIds.indexOf(id);
      if (index < 0 || !isDeepStrictEqual(retained!.settings[index], settings))
        throw new CollaborationContractError('snapshot_changed');
    },
  };
}
