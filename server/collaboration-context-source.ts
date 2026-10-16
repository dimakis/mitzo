import { isDeepStrictEqual } from 'node:util';
import { CollaborationContractError, CollaborationSnapshotSelectionSchema } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { AuthorizedCollaborationContext } from './collaboration-context-compiler.js';

/** Host composition only. Authorization is the existing operator/session owner's live check,
 * never a client-supplied allow flag. Registered inline output v1 is the supported artifact kind.
 * This adapter provides no capacity assessment, ordinary allocation or execution capability.
 */
export function createCollaborationContextSource(deps: {
  store: EventStore;
  authorizeConversation(sessionId: string): Promise<void>;
}): AuthorizedCollaborationContext {
  let openedSession: string | undefined;
  let openedBoundary: number | undefined;
  async function authorize(sessionId: string) {
    await deps.authorizeConversation(sessionId);
    const session = deps.store.getSession(sessionId);
    if (
      !session ||
      session.isHidden ||
      session.sessionType === 'symposium' ||
      session.symposiumConfig
    )
      throw new CollaborationContractError('unavailable_recipient');
  }
  function exactOutput(pin: Parameters<AuthorizedCollaborationContext['authorizeArtifact']>[0]) {
    if (!openedSession) throw new CollaborationContractError('snapshot_changed');
    const output = deps.store.getSessionOutput(openedSession, pin.artifactId);
    if (
      !output ||
      output.sourceAvailability !== 'available' ||
      output.provenance ||
      output.source.messageEndSeq > openedBoundary! ||
      !isDeepStrictEqual(
        { artifactId: output.outputId, revision: output.revision, sha256: output.source.sha256 },
        pin,
      )
    )
      throw new CollaborationContractError('snapshot_changed');
    return output;
  }
  return {
    async openConversation(raw) {
      const selection = CollaborationSnapshotSelectionSchema.parse(raw);
      await authorize(selection.sourceConversationId);
      // Each compilation receives a fresh capability; never reuse it across discussions.
      if (openedSession) throw new CollaborationContractError('snapshot_changed');
      openedSession = selection.sourceConversationId;
      openedBoundary = selection.boundary.sequence;
      const source = deps.store.openCollaborationVisibleSource(openedSession, selection.boundary);
      return {
        sourceIdentity: source.sourceIdentity,
        sourceConversationId: source.sourceConversationId,
        boundary: source.boundary,
        async readPrefixWitness() {
          await authorize(source.sourceConversationId);
          return source.readPrefixWitness();
        },
        async readPage(after, limit) {
          await authorize(source.sourceConversationId);
          return source.readPage(after, limit);
        },
        async readSelected(ids) {
          await authorize(source.sourceConversationId);
          return source.readSelected(ids);
        },
        async assertCurrent() {
          await authorize(source.sourceConversationId);
          source.assertCurrent();
        },
      };
    },
    async authorizeArtifact(pin) {
      if (!openedSession) throw new CollaborationContractError('snapshot_changed');
      await authorize(openedSession);
      exactOutput(pin);
    },
    async readArtifact(pin) {
      if (!openedSession) throw new CollaborationContractError('snapshot_changed');
      await authorize(openedSession);
      exactOutput(pin);
      const { output, content } = deps.store.readSessionOutput(openedSession, pin.artifactId);
      await authorize(openedSession);
      exactOutput(pin);
      return {
        ...pin,
        sourceConversationId: output.sessionId,
        mediaType: 'text/plain; charset=utf-8',
        bytes: Buffer.from(content, 'utf8'),
      };
    },
  };
}
