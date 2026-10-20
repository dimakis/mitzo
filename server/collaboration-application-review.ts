import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  CollaborationContractError,
  CollaborationApplicationReviewInputSchema,
  CollaborationApplicationReviewResultSchema,
  createOrdinaryFreshPermission,
  type CollaborationApplicationReviewInput,
  type CollaborationSnapshot,
  type CollaborationSettings,
} from '@mitzo/protocol';
import { isAuthSessionCurrent, type AuthSession } from './auth.js';
import {
  captureAgentLibraryAuthorization,
  readAgentLibraryProfile,
} from './agent-library-transport.js';
import { liveTransportAuthSessionId } from './transport-auth-ownership.js';
import { getAgentLibrary } from './agent-library-runtime.js';
import { loadAccountProfiles } from './account-profiles.js';
import {
  readOrdinaryCodexAgentProfile,
  resolveOrdinaryCodexAgentProfile,
} from './ordinary-codex-agent-profile.js';
import { assertOrdinarySilentPreparationAuthority } from './ordinary-repository-preparation-authority.js';
import { OrdinaryCollaborationReview } from './collaboration-review-owner.js';
import { createCollaborationContextSource } from './collaboration-context-source.js';
import { createCollaborationRetainedContext } from './collaboration-retained-context-source.js';
import type { TelosArtifactStore } from './telos-artifact-store.js';
import type { EventStore } from './event-store.js';
import type { RepositoryWorkspaces } from './repository-workspaces.js';

const unavailable = () => new CollaborationContractError('execution_unavailable');

/** Observational application composition. The actual ordinary owners resolve all
 * settings and source access; this owner cannot allocate, enqueue or dispatch.
 * No native capacity adapter is installed, so every new review is unverified.
 */
export class CollaborationApplicationReview {
  constructor(
    private readonly owners: {
      store: EventStore;
      workspaces: RepositoryWorkspaces;
      retainedArtifacts?: TelosArtifactStore;
    },
  ) {}

  async review(
    auth: AuthSession,
    operatorConnectionId: string,
    group: string,
    raw: unknown,
    signal: AbortSignal,
  ) {
    const input = CollaborationApplicationReviewInputSchema.parse(raw);
    const applicationInputSha256 = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const operator = captureAgentLibraryAuthorization(operatorConnectionId);
    const assertObservation = () => {
      signal.throwIfAborted();
      operator.assertCurrent();
      if (
        !isAuthSessionCurrent(auth) ||
        operator.auth.id !== auth.id ||
        liveTransportAuthSessionId(operatorConnectionId) !== auth.id
      )
        throw unavailable();
      const membership = this.owners.store.getSessionCollaboration(group);
      const source = this.owners.store.getSession(input.selection.sourceConversationId);
      if (
        !membership?.participantSessionIds.includes(input.selection.sourceConversationId) ||
        !source ||
        source.isHidden ||
        source.sessionType === 'symposium' ||
        source.symposiumConfig
      )
        throw unavailable();
    };
    assertObservation();
    const result = async (
      snapshot: CollaborationSnapshot,
      settings: CollaborationSettings,
      expectedMembershipRevision: number,
    ) => {
      assertObservation();
      const visible = this.owners.store.openCollaborationVisibleSource(
        snapshot.sourceConversationId,
        snapshot.boundary,
      );
      const retainedSource = createCollaborationRetainedContext({
        source: visible,
        artifacts: this.owners.retainedArtifacts,
        authorize: async () => assertObservation(),
        assertSourceCurrent: assertObservation,
      });
      const outputs = new Map<string, ReturnType<EventStore['getSessionOutput']>>();
      const artifactLabels = [];
      for (const pin of snapshot.artifacts) {
        if ('kind' in pin) {
          const metadata = await retainedSource.metadata({
            kind: pin.kind,
            artifactId: pin.artifactId,
            revision: pin.revision,
            sha256: pin.sha256,
          });
          const { contentBase64, ...frozen } = pin;
          const bytes = Buffer.from(contentBase64, 'base64');
          if (
            !isDeepStrictEqual(metadata, frozen) ||
            bytes.byteLength !== metadata.sizeBytes ||
            createHash('sha256').update(bytes).digest('hex') !== pin.sha256
          )
            throw new CollaborationContractError('snapshot_changed');
          artifactLabels.push({
            kind: pin.kind,
            artifactId: pin.artifactId,
            revision: pin.revision,
            sha256: pin.sha256,
            title: metadata.title,
            filename: metadata.filename,
          });
          continue;
        }
        const output = this.owners.store.getSessionOutput(
          snapshot.sourceConversationId,
          pin.artifactId,
        );
        if (
          !output ||
          output.sourceAvailability !== 'available' ||
          output.provenance ||
          output.revision !== pin.revision ||
          output.source.sha256 !== pin.sha256 ||
          output.source.messageEndSeq > snapshot.boundary.sequence
        )
          throw new CollaborationContractError('snapshot_changed');
        outputs.set(pin.artifactId, output);
        artifactLabels.push({
          artifactId: pin.artifactId,
          revision: pin.revision,
          sha256: pin.sha256,
          title: output.title,
        });
      }
      assertObservation();
      visible.assertCurrent();
      retainedSource.assertOwnedCurrent();
      for (const [id, output] of outputs)
        if (
          !isDeepStrictEqual(
            this.owners.store.getSessionOutput(snapshot.sourceConversationId, id),
            output,
          )
        )
          throw new CollaborationContractError('snapshot_changed');
      return CollaborationApplicationReviewResultSchema.parse({
        snapshot,
        settings,
        expectedMembershipRevision,
        artifactLabels,
      });
    };
    const retained = () => {
      const record = this.owners.store.collaborationConversation.getReviewCompilation(
        group,
        input.selection.requestId,
      );
      if (
        record &&
        (record.operatorId !== auth.id || record.applicationInputSha256 !== applicationInputSha256)
      )
        throw new CollaborationContractError('request_conflict');
      return record;
    };
    const recovered = (record: NonNullable<ReturnType<typeof retained>>) => {
      assertObservation();
      const snapshot =
        record.snapshotId &&
        this.owners.store.collaborationConversation.getSnapshot(group, record.snapshotId);
      if (!snapshot || record.settings.length !== 1)
        throw new CollaborationContractError('snapshot_changed');
      return result(snapshot, record.settings[0], record.selection.expectedMembershipRevision);
    };
    const original = retained();
    if (original?.snapshotId) return recovered(original);
    const previous =
      input.previousSnapshot &&
      this.owners.store.collaborationConversation.getSnapshot(
        group,
        input.previousSnapshot.snapshotId,
      );
    if (
      input.previousSnapshot &&
      (!previous ||
        previous.sha256 !== input.previousSnapshot.sha256 ||
        previous.sourceConversationId !== input.selection.sourceConversationId)
    )
      throw new CollaborationContractError('snapshot_changed');

    let resolved: Awaited<ReturnType<CollaborationApplicationReview['resolveSettings']>>;
    try {
      resolved = await this.resolveSettings(input.target, operatorConnectionId, signal);
    } catch {
      // Account/credential/provider diagnostics may contain private paths or text.
      throw unavailable();
    }
    assertObservation();
    const afterResolution = retained();
    if (afterResolution?.snapshotId) return recovered(afterResolution);
    if (
      afterResolution &&
      (afterResolution.settings.length !== 1 ||
        !isDeepStrictEqual(afterResolution.settings[0], resolved.settings))
    )
      throw new CollaborationContractError('snapshot_changed');
    const source = createCollaborationContextSource({
      store: this.owners.store,
      retainedArtifacts: this.owners.retainedArtifacts,
      authorizeConversation: async () => {
        assertObservation();
      },
      assertConversationCurrent: () => {
        assertObservation();
        resolved.assertCurrent();
      },
    });
    const review = new OrdinaryCollaborationReview({
      store: this.owners.store,
      source: () => source,
    });
    const snapshot = await review.review(
      group,
      {
        operatorId: auth.id,
        selection: input.selection,
        settings: [resolved.settings],
        applicationInputSha256,
      },
      { assertBeforeCommit: () => source.assertCurrentAtSave() },
    );
    assertObservation();
    return result(snapshot, resolved.settings, input.selection.expectedMembershipRevision);
  }

  private async resolveSettings(
    target: CollaborationApplicationReviewInput['target'],
    connectionId: string,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    if (!target.agent) throw unavailable(); // The ordinary profile resolver has no implicit default.
    const record = this.owners.workspaces.get(target.repositoryWorkspaceId);
    const proof = record.ordinaryPreparation;
    if (
      !proof ||
      record.state !== 'ready' ||
      record.conversationId ||
      record.hostReservation ||
      record.ordinaryFirstReservation ||
      record.handoff ||
      proof.runtimeBinding.execution.location !== target.runOn ||
      proof.runtimeBinding.harness.implementation !== 'codex'
    )
      throw unavailable();
    const profiles = loadAccountProfiles();
    const binding = profiles.resolve(target.accountId, target.model);
    profiles.validateModelSelection(binding, target.model, target.reasoningEffort);
    const { ordinaryRepositoryRuntimeInventory } = await import('./ordinary-local-codex-entry.js');
    const resolveBinding = () => {
      const inventory = ordinaryRepositoryRuntimeInventory(target.runOn, 'codex');
      const current = inventory.profiles.resolve(target.accountId, target.model);
      inventory.profiles.validateModelSelection(current, target.model, target.reasoningEffort);
      const result = inventory.catalog.resolve({
        account: {
          accountId: current.accountId,
          provider: current.provider,
          profileRevision: current.profileRevision,
        },
        harness: 'codex',
        targetId: proof.runtimeBinding.execution.targetId,
        mode: target.permissionMode,
      });
      if (
        result.status !== 'compatible' ||
        !isDeepStrictEqual(result.binding, proof.runtimeBinding) ||
        !isDeepStrictEqual({ ...record.binding, model: binding.model }, binding)
      )
        throw unavailable();
      return result.binding;
    };
    const runtime = resolveBinding();
    const agent = await resolveOrdinaryCodexAgentProfile({
      requested: target.agent,
      provider: binding.provider,
      execution: runtime.execution,
      lookup: (selection) => readAgentLibraryProfile(selection, connectionId),
    });
    if (!agent || agent.definition.contextRecipe !== undefined) throw unavailable();
    const settings: CollaborationSettings = {
      binding: runtime,
      selection: {
        version: 1,
        agent: target.agent,
        context: { source: 'none', revision: null },
        permission: createOrdinaryFreshPermission(target.permissionMode),
        model: target.model,
        thinking: target.reasoningEffort,
      },
      repositoryWorkspaceId: target.repositoryWorkspaceId,
    };
    await this.owners.workspaces.qualifiedStatus(record.id, binding);
    await assertOrdinarySilentPreparationAuthority(proof, binding, settings, signal);
    const assertCurrent = () => {
      signal.throwIfAborted();
      resolveBinding();
      if (
        !isDeepStrictEqual(this.owners.workspaces.get(record.id), record) ||
        !isDeepStrictEqual(readOrdinaryCodexAgentProfile(getAgentLibrary(), target.agent!), agent)
      )
        throw unavailable();
    };
    assertCurrent();
    return { settings, assertCurrent };
  }
}
