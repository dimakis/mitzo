import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
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
  /** Actual synchronous operator/privacy owner, used only at the snapshot save boundary. */
  assertConversationCurrent?(sessionId: string): void;
}): AuthorizedCollaborationContext & { assertCurrentAtSave(): void } {
  let openedSession: string | undefined;
  let openedBoundary: number | undefined;
  let openedSource: ReturnType<EventStore['openCollaborationVisibleSource']> | undefined;
  type Pin = Parameters<AuthorizedCollaborationContext['authorizeArtifact']>[0];
  const artifacts = new Map<string, { pin: Pin; bytes: number; digest: string }>();
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  function assertVisible(sessionId: string) {
    const session = deps.store.getSession(sessionId);
    if (
      !session ||
      session.isHidden ||
      session.sessionType === 'symposium' ||
      session.symposiumConfig
    )
      throw new CollaborationContractError('unavailable_recipient');
  }
  async function authorize(sessionId: string) {
    await deps.authorizeConversation(sessionId);
    assertVisible(sessionId);
  }
  function exactOutput(pin: Parameters<AuthorizedCollaborationContext['authorizeArtifact']>[0]) {
    if ('kind' in pin) throw new CollaborationContractError('snapshot_changed');
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
  function assertCurrentAtSave() {
    if (!openedSession || !openedSource || !deps.assertConversationCurrent)
      throw new CollaborationContractError('snapshot_changed');
    const asserted: unknown = deps.assertConversationCurrent(openedSession);
    if (asserted !== undefined) {
      // TypeScript's void callback type also accepts async functions. Drain
      // accidental promises without treating completion as a save authority.
      void Promise.resolve(asserted).catch(() => {});
      throw new CollaborationContractError('snapshot_changed');
    }
    assertVisible(openedSession);
    openedSource.assertCurrent();
    // Check retained aggregate bounds before rereading any registered output.
    // The output owner itself bounds each current source read to 256 KiB.
    if (
      artifacts.size > 100 ||
      [...artifacts.values()].reduce((sum, item) => sum + item.bytes, 0) > 512 * 1024
    )
      throw new CollaborationContractError('capacity_refused');
    for (const original of artifacts.values()) {
      exactOutput(original.pin);
      const { content } = deps.store.readSessionOutput(openedSession, original.pin.artifactId);
      const bytes = Buffer.from(content, 'utf8');
      if (bytes.length !== original.bytes || hash(bytes) !== original.digest)
        throw new CollaborationContractError('snapshot_changed');
    }
  }
  return {
    assertCurrentAtSave,
    async openConversation(raw) {
      const selection = CollaborationSnapshotSelectionSchema.parse(raw);
      await authorize(selection.sourceConversationId);
      // Each compilation receives a fresh capability; never reuse it across discussions.
      if (openedSession) throw new CollaborationContractError('snapshot_changed');
      openedSession = selection.sourceConversationId;
      openedBoundary = selection.boundary.sequence;
      const source = deps.store.openCollaborationVisibleSource(openedSession, selection.boundary);
      openedSource = source;
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
      const key = `${pin.artifactId}:${pin.revision}`;
      if (!artifacts.has(key) && artifacts.size >= 100)
        throw new CollaborationContractError('capacity_refused');
      const { output, content } = deps.store.readSessionOutput(openedSession, pin.artifactId);
      await authorize(openedSession);
      exactOutput(pin);
      const bytes = Buffer.from(content, 'utf8');
      const observed = { pin: structuredClone(pin), bytes: bytes.length, digest: hash(bytes) };
      if (
        (artifacts.has(key) && !isDeepStrictEqual(artifacts.get(key), observed)) ||
        [...artifacts].reduce(
          (sum, [otherKey, item]) => sum + (otherKey === key ? 0 : item.bytes),
          bytes.length,
        ) >
          512 * 1024
      )
        throw new CollaborationContractError('snapshot_changed');
      artifacts.set(key, observed);
      return {
        ...pin,
        sourceConversationId: output.sessionId,
        mediaType: 'text/plain; charset=utf-8',
        bytes,
        assertCurrent: assertCurrentAtSave,
      };
    },
  };
}
