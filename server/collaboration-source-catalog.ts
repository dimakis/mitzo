import { isDeepStrictEqual } from 'node:util';
import {
  CollaborationContractError,
  CollaborationDurableTranscriptSchema,
  CollaborationSourceCatalogRequestSchema,
  CollaborationSourceCatalogSchema,
  CollaborationSourceArtifactVersionsRequestSchema,
  CollaborationSourceArtifactVersionsSchema,
} from '@mitzo/protocol';
import { isAuthSessionCurrent, type AuthSession } from './auth.js';
import { captureAgentLibraryAuthorization } from './agent-library-transport.js';
import { liveTransportAuthSessionId } from './transport-auth-ownership.js';
import { createCollaborationRetainedContext } from './collaboration-retained-context-source.js';
import type { EventStore } from './event-store.js';
import type { TelosArtifactStore } from './telos-artifact-store.js';
const unavailable = () => new CollaborationContractError('execution_unavailable');
/** Authenticated observation of the actual visible prefix, immutable revision
 * owner and source repository claim. Nothing here prepares a target or a turn. */
export class CollaborationSourceCatalog {
  constructor(
    private readonly owners: {
      store: EventStore;
      openArtifacts(): TelosArtifactStore | undefined;
      repositoryIntent(
        conversationId: string,
        expectedWorkspaceId: string,
      ): { repository: string } | null;
    },
  ) {}
  private observation(
    auth: AuthSession,
    input: { sourceConversationId: string; clientId: string },
    signal: AbortSignal,
  ) {
    const operator = captureAgentLibraryAuthorization(input.clientId);
    const assertCurrent = () => {
      signal.throwIfAborted();
      operator.assertCurrent();
      const source = this.owners.store.getSession(input.sourceConversationId);
      if (
        !isAuthSessionCurrent(auth) ||
        operator.auth.id !== auth.id ||
        liveTransportAuthSessionId(input.clientId) !== auth.id ||
        !source ||
        source.isHidden ||
        source.sessionType === 'symposium' ||
        source.symposiumConfig ||
        source.conversationSource === 'external_import'
      )
        throw unavailable();
    };
    assertCurrent();
    return assertCurrent;
  }
  async read(auth: AuthSession, raw: unknown, signal: AbortSignal) {
    const input = CollaborationSourceCatalogRequestSchema.parse(raw);
    const assertCurrent = this.observation(auth, input, signal);
    const transcript = CollaborationDurableTranscriptSchema.parse(
      this.owners.store.getDurableSessionTranscript(input.sourceConversationId),
    );
    const source = this.owners.store.openCollaborationVisibleSource(
      input.sourceConversationId,
      transcript.boundary,
    );
    const witness = source.readPrefixWitness();
    const artifacts = this.owners.openArtifacts();
    try {
      if (input.artifactsAfter && !artifacts) throw unavailable();
      const retained = createCollaborationRetainedContext({
        source,
        artifacts,
        authorize: async () => assertCurrent(),
        assertSourceCurrent: assertCurrent,
      });
      const page = artifacts
        ? await retained.catalog(input.artifactsAfter)
        : { artifacts: [], cursor: null, hasMore: false, unversionedReferences: false };
      const inline = witness.artifactPins.map((pin) => {
        const output = this.owners.store.getSessionOutput(
          input.sourceConversationId,
          pin.artifactId,
        );
        if (
          !output ||
          output.provenance ||
          output.sourceAvailability !== 'available' ||
          output.revision !== pin.revision ||
          output.source.sha256 !== pin.sha256 ||
          output.source.messageEndSeq > transcript.boundary.sequence
        )
          throw new CollaborationContractError('snapshot_changed');
        return { pin, output };
      });
      const sourceMeta = this.owners.store.getSession(input.sourceConversationId)!;
      const repository = () =>
        sourceMeta.repositoryWorkspaceId
          ? this.owners.repositoryIntent(
              input.sourceConversationId,
              sourceMeta.repositoryWorkspaceId,
            )
          : null;
      const sourceRepository = repository();
      const result = CollaborationSourceCatalogSchema.parse({
        ...transcript,
        artifacts: [
          ...inline.map(({ pin, output }) => ({ ...pin, title: output.title })),
          ...page.artifacts,
        ],
        artifactCursor: page.cursor,
        artifactHasMore: page.hasMore,
        retainedAvailability: artifacts ? 'available' : 'unavailable',
        unversionedRetainedReferences: retained.unversionedReferences(),
        sourceRepository,
      });
      if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024)
        throw new CollaborationContractError('capacity_refused');
      if (!isDeepStrictEqual(repository(), sourceRepository))
        throw new CollaborationContractError('snapshot_changed');
      assertCurrent();
      source.assertCurrent();
      retained.assertOwnedCurrent();
      for (const { pin, output } of inline)
        if (
          !isDeepStrictEqual(
            this.owners.store.getSessionOutput(input.sourceConversationId, pin.artifactId),
            output,
          )
        )
          throw new CollaborationContractError('snapshot_changed');
      if (
        this.owners.store.getSession(input.sourceConversationId)?.repositoryWorkspaceId !==
        sourceMeta.repositoryWorkspaceId
      )
        throw new CollaborationContractError('snapshot_changed');
      return result;
    } finally {
      artifacts?.close();
    }
  }
  async versions(auth: AuthSession, raw: unknown, signal: AbortSignal) {
    const input = CollaborationSourceArtifactVersionsRequestSchema.parse(raw);
    const assertCurrent = this.observation(auth, input, signal);
    const source = this.owners.store.openCollaborationVisibleSource(
      input.sourceConversationId,
      input.boundary,
    );
    const artifacts = this.owners.openArtifacts();
    if (!artifacts) throw unavailable();
    try {
      const retained = createCollaborationRetainedContext({
        source,
        artifacts,
        authorize: async () => assertCurrent(),
        assertSourceCurrent: assertCurrent,
      });
      const page = await retained.revisionPage(input.artifact, {
        beforeRevision: input.beforeRevision,
        limit: input.limit,
      });
      const result = CollaborationSourceArtifactVersionsSchema.parse({
        sourceConversationId: input.sourceConversationId,
        boundary: input.boundary,
        ...page,
      });
      assertCurrent();
      source.assertCurrent();
      retained.assertOwnedCurrent();
      return result;
    } finally {
      artifacts.close();
    }
  }
}
