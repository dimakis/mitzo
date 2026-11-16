import { createHash } from 'node:crypto';
import { CollaborationContractError, CollaborationSnapshotMessageSchema } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { AuthorizedCollaborationContext } from './collaboration-context-compiler.js';

const changed = (): never => {
  throw new CollaborationContractError('snapshot_changed');
};
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/** Exact public discussion messages, never a participant's provider history.
 * Restricted to selected text in this same group; caller renews ordinary actor
 * and audience authority at every read and at the final synchronous save fence.
 */
export function createSharedConversationContextSource(
  store: EventStore,
  group: string,
  assertAuthorized: () => void,
): AuthorizedCollaborationContext & { assertCurrentAtSave(): void } {
  let opened:
    { revision: number; boundary: { sequence: number; messageId: string | null } } | undefined;
  const selected = new Map<string, string>();
  const read = (id: string) => {
    assertAuthorized();
    const message = store.collaborationConversation.getMessage(group, id);
    if (!message || !opened || message.sequence > opened.boundary.sequence || !message.text.trim())
      return changed();
    return CollaborationSnapshotMessageSchema.parse({
      conversationId: group,
      messageId: message.messageId,
      sequence: message.sequence,
      author: message.author,
      ...(message.recordedAt !== undefined ? { recordedAt: message.recordedAt } : {}),
      source: null,
      blocks: [
        { blockId: message.messageId + ':text', content: message.text, sha256: sha(message.text) },
      ],
    });
  };
  const assertCurrentAtSave = () => {
    assertAuthorized();
    if (!opened || store.getSessionCollaboration(group)?.revision !== opened.revision)
      return changed();
    if (
      !opened.boundary.messageId ||
      store.collaborationConversation.getMessage(group, opened.boundary.messageId)?.sequence !==
        opened.boundary.sequence
    )
      return changed();
    for (const [id, digest] of selected)
      if (sha(JSON.stringify(read(id))) !== digest) return changed();
  };
  return {
    assertCurrentAtSave,
    async openConversation(selection) {
      assertAuthorized();
      if (
        opened ||
        selection.sourceConversationId !== group ||
        selection.mode !== 'selected' ||
        selection.artifacts.length
      )
        return changed();
      opened = { revision: selection.expectedMembershipRevision, boundary: selection.boundary };
      assertCurrentAtSave();
      return {
        sourceIdentity: 'shared:' + sha(JSON.stringify([group, opened.boundary])),
        sourceConversationId: group,
        boundary: selection.boundary,
        async readPrefixWitness() {
          return changed();
        },
        async readPage() {
          return changed();
        },
        async readSelected(ids) {
          assertCurrentAtSave();
          return ids.map((id) => {
            const message = read(id);
            const digest = sha(JSON.stringify(message));
            if (selected.has(id) && selected.get(id) !== digest) return changed();
            selected.set(id, digest);
            return message;
          });
        },
        async assertCurrent() {
          assertCurrentAtSave();
        },
      };
    },
    async authorizeArtifact() {
      return changed();
    },
    async readArtifact() {
      return changed();
    },
  };
}
