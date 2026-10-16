import { CollaborationContractError } from '@mitzo/protocol';
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

  async review(group: string, raw: unknown) {
    const record = this.deps.store.collaborationConversation.reserveReviewCompilation(group, raw);
    if (record.snapshotId) {
      const snapshot = this.deps.store.collaborationConversation.getSnapshot(
        group,
        record.snapshotId,
      );
      if (!snapshot) throw new CollaborationContractError('snapshot_changed');
      return snapshot;
    }
    const draft = await compileCollaborationContext(
      record.selection,
      record.settings,
      this.deps.source(record.operatorId),
      this.deps.capacity,
    );
    return this.deps.store.collaborationConversation.completeReviewCompilation(
      group,
      record.selection.requestId,
      draft,
    );
  }
}
