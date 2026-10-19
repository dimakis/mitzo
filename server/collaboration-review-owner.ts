import {
  CollaborationContractError,
  type CollaborationNativeCapacityWitness,
} from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import {
  compileCollaborationContext,
  type AuthorizedCollaborationContext,
  type CollaborationCapacityAdapter,
} from './collaboration-context-compiler.js';

/** Host composition of the existing source/compiler and EventStore request owner.
 * Settings must come from ordinary admission/preparation, never HTTP capacity or
 * binding claims. This port neither allocates nor dispatches. Recovering a saved
 * review is not authority to confirm or deliver it: those need fresh fences.
 */
export class OrdinaryCollaborationReview {
  constructor(
    private readonly deps: {
      store: EventStore;
      source(operatorId: string): AuthorizedCollaborationContext;
      capacity?: CollaborationCapacityAdapter;
    },
  ) {}

  async review(group: string, raw: unknown, options?: { assertBeforeCommit(): void }) {
    const record = this.deps.store.collaborationConversation.reserveReviewCompilation(group, raw);
    if (record.snapshotId) {
      const snapshot = this.deps.store.collaborationConversation.getSnapshot(
        group,
        record.snapshotId,
      );
      if (!snapshot) throw new CollaborationContractError('snapshot_changed');
      return snapshot;
    }
    let witnesses: CollaborationNativeCapacityWitness[] = [];
    const draft = await compileCollaborationContext(
      record.selection,
      record.settings,
      this.deps.source(record.operatorId),
      this.deps.capacity,
      {
        reviewIdentity: {
          collaborationId: group,
          operatorId: record.operatorId,
          requestId: record.selection.requestId,
        },
        retainNativeWitnesses: (retained) => {
          witnesses = retained;
        },
      },
    );
    return this.deps.store.collaborationConversation.completeReviewCompilation(
      group,
      record.selection.requestId,
      draft,
      witnesses,
      options?.assertBeforeCommit,
    );
  }
}
