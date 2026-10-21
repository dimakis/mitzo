import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { CollaborationContractError, CollaborationSnapshotSelectionSchema } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { AuthorizedCollaborationContext } from './collaboration-context-compiler.js';
import { createCollaborationRetainedContext } from './collaboration-retained-context-source.js';
import type { TelosArtifactStore } from './telos-artifact-store.js';

/** Host composition only. Authorization is the existing operator/session owner's live check,
 * never a client-supplied allow flag. Retained versions require their actual
 * optional revision owner; bare selectors always remain registered inline outputs.
 * This adapter provides no capacity assessment, ordinary allocation or execution capability.
 */
export function createCollaborationContextSource(deps: {
  store: EventStore;
  retainedArtifacts?: TelosArtifactStore;
  authorizeConversation(sessionId: string): Promise<void>;
  /** Actual synchronous operator/privacy owner, used only at the snapshot save boundary. */
  assertConversationCurrent?(sessionId: string): void;
}): AuthorizedCollaborationContext & { assertCurrentAtSave(): void } {
  let openedSession: string | undefined;
  let openedBoundary: number | undefined;
  let openedSource: ReturnType<EventStore['openCollaborationVisibleSource']> | undefined;
  let retained: ReturnType<typeof createCollaborationRetainedContext> | undefined;
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
  function assertOpenedCurrent() {
    if (!openedSession || !openedSource) throw new CollaborationContractError('snapshot_changed');
    assertVisible(openedSession);
    openedSource.assertCurrent();
  }
  function assertSourceCurrent() {
    if (!openedSession || !deps.assertConversationCurrent)
      throw new CollaborationContractError('snapshot_changed');
    const asserted: unknown = deps.assertConversationCurrent(openedSession);
    if (asserted !== undefined) {
      // TypeScript's void callback type also accepts async functions. Drain
      // accidental promises without treating completion as a save authority.
      void Promise.resolve(asserted).catch(() => {});
      throw new CollaborationContractError('snapshot_changed');
    }
    assertOpenedCurrent();
  }
  function assertCurrentAtSave() {
    assertSourceCurrent();
    retained?.assertAuthorityCurrent();
    // No supplied authority callback runs after this point. Finish all original
    // source and artifact witnesses after callbacks for every selected artifact.
    assertOpenedCurrent();
    const session = openedSession;
    if (!session) throw new CollaborationContractError('snapshot_changed');
    const independent = retained?.stats() ?? { count: 0, bytes: 0 };
    // Check retained aggregate bounds before rereading any registered output.
    // The output owner itself bounds each current source read to 256 KiB.
    if (
      artifacts.size + independent.count > 100 ||
      [...artifacts.values()].reduce((sum, item) => sum + item.bytes, independent.bytes) >
        512 * 1024
    )
      throw new CollaborationContractError('capacity_refused');
    for (const original of artifacts.values()) {
      exactOutput(original.pin);
      const { content } = deps.store.readSessionOutput(session, original.pin.artifactId);
      const bytes = Buffer.from(content, 'utf8');
      if (bytes.length !== original.bytes || hash(bytes) !== original.digest)
        throw new CollaborationContractError('snapshot_changed');
    }
    retained?.assertOwnedCurrent();
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
      retained = createCollaborationRetainedContext({
        source,
        artifacts: deps.retainedArtifacts,
        authorize: () => authorize(source.sourceConversationId),
        assertSourceCurrent,
      });
      await retained.prepare(selection.mode);
      return {
        sourceIdentity: source.sourceIdentity,
        sourceConversationId: source.sourceConversationId,
        boundary: source.boundary,
        async readPrefixWitness() {
          await authorize(source.sourceConversationId);
          const witness = source.readPrefixWitness();
          const artifactPins = [...witness.artifactPins, ...retained!.pins()];
          if (artifactPins.length > 100) throw new CollaborationContractError('capacity_refused');
          return { ...witness, artifactPins };
        },
        async readPage(after, limit) {
          await authorize(source.sourceConversationId);
          const page = source.readPage(after, limit);
          return {
            ...page,
            artifacts: [...page.artifacts, ...retained!.pins(after, page.throughSequence)],
          };
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
      if ('kind' in pin) {
        if (!retained) throw new CollaborationContractError('snapshot_changed');
        return retained.authorize(pin);
      }
      exactOutput(pin);
    },
    async readArtifact(pin) {
      if (!openedSession) throw new CollaborationContractError('snapshot_changed');
      await authorize(openedSession);
      if ('kind' in pin) {
        if (!retained) throw new CollaborationContractError('snapshot_changed');
        const value = await retained.read(pin);
        const independent = retained.stats();
        if (
          artifacts.size + independent.count > 100 ||
          [...artifacts.values()].reduce((sum, item) => sum + item.bytes, independent.bytes) >
            512 * 1024
        )
          throw new CollaborationContractError('capacity_refused');
        return { ...value, assertCurrent: assertCurrentAtSave };
      }
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
