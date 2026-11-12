import { isDeepStrictEqual } from 'node:util';
import {
  CollaborationContractError,
  CollaborationForwardPrepareInputSchema,
  CollaborationForwardConfirmInputSchema,
  CollaborationForwardPacketSchema,
  type CollaborationForwardPreparation,
  type CollaborationSettings,
} from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import { isAuthSessionCurrent, type AuthSession } from './auth.js';
import { captureAgentLibraryAuthorization } from './agent-library-transport.js';
import { liveTransportAuthSessionId } from './transport-auth-ownership.js';
import { ordinaryOperatorOwnsConversation } from './ordinary-operator-identity.js';
import { createCollaborationContextSource } from './collaboration-context-source.js';
import { prepareCollaborationForward } from './collaboration-forwarding.js';
import { forwardInputMaterial } from './collaboration-context-input.js';
import type { RetainedCollaborationArtifactSource } from './collaboration-retained-artifact-source.js';

export interface CollaborationRetainedArtifactPort {
  source(assertAuthorized: () => void): RetainedCollaborationArtifactSource;
  close(): void;
}
const changed = () => new CollaborationContractError('snapshot_changed');
/** Existing durable forwarding + source + ordinary settings owners. Preparing
 * and confirming context never allocate an agent or request a model turn. */
export class CollaborationApplicationForwarding {
  constructor(
    private readonly store: EventStore,
    private readonly retained?: CollaborationRetainedArtifactPort,
  ) {}

  private actor(auth: AuthSession, clientId: string, signal?: AbortSignal) {
    const operator = captureAgentLibraryAuthorization(clientId);
    return () => {
      signal?.throwIfAborted();
      operator.assertCurrent();
      if (
        !isAuthSessionCurrent(auth) ||
        operator.auth.id !== auth.id ||
        liveTransportAuthSessionId(clientId) !== auth.id
      )
        throw new CollaborationContractError('execution_unavailable');
    };
  }
  private provenance(auth: AuthSession, record: CollaborationForwardPreparation) {
    if (
      !isAuthSessionCurrent(auth) ||
      !ordinaryOperatorOwnsConversation(record.operatorId, auth.id)
    )
      throw new CollaborationContractError('execution_unavailable');
  }
  private currentMaterial(
    auth: AuthSession,
    group: string,
    record: CollaborationForwardPreparation,
    signal: AbortSignal,
  ) {
    return () => {
      signal.throwIfAborted();
      this.provenance(auth, record);
      const id = record.input.selection.sourceConversationId;
      if (id) {
        const source = this.store.getSession(id);
        if (
          !source ||
          source.isHidden ||
          source.sessionType === 'symposium' ||
          source.symposiumConfig
        )
          throw changed();
        this.store.collaborationConversation.assertCurrentForwardSource(group, record.forwardId);
      }
    };
  }
  private targets(
    group: string,
    record: CollaborationForwardPreparation,
    strict: boolean,
    ids = record.input.selection.target.sessionIds,
  ) {
    const membership = this.store.getSessionCollaboration(group);
    if (
      !membership ||
      (strict && membership.revision !== record.input.selection.target.expectedMembershipRevision)
    )
      throw changed();
    for (const id of ids) {
      const settings = this.store.getOrdinaryConversationSettings(id);
      if (
        !record.input.selection.target.sessionIds.includes(id) ||
        !membership.participantSessionIds.includes(id) ||
        !settings ||
        settings.binding.harness.implementation !== 'codex' ||
        settings.binding.execution.location !== 'local' ||
        !isDeepStrictEqual(settings, record.settings[id])
      )
        throw changed();
    }
  }
  private async compile(
    auth: AuthSession,
    group: string,
    record: CollaborationForwardPreparation,
    signal: AbortSignal,
    assertOwner: () => void,
    strict: boolean,
    ids?: string[],
  ) {
    const materialCurrent = this.currentMaterial(auth, group, record, signal);
    const current = () => {
      assertOwner();
      materialCurrent();
      this.targets(group, record, strict, ids);
    };
    current();
    const source =
      record.input.selection.sourceConversationId === null
        ? undefined
        : createCollaborationContextSource({
            store: this.store,
            authorizeConversation: async () => current(),
            assertConversationCurrent: current,
          });
    const prepared = await prepareCollaborationForward(record.input.selection, {
      source,
      retainedArtifacts: this.retained?.source(current),
      authorizeTarget: async () => current(),
    });
    const packet = CollaborationForwardPacketSchema.parse(prepared.packet);
    // Eligibility precedes confirmation; a note must never ACK omitted bytes.
    const material = forwardInputMaterial(packet);
    if (
      Buffer.byteLength(JSON.stringify(material), 'utf8') +
        Buffer.byteLength(record.input.note, 'utf8') >
      512 * 1024
    )
      throw new CollaborationContractError('capacity_refused');
    const assertCurrent = () => {
      current();
      prepared.assertLocalMaterialCurrent();
    };
    assertCurrent();
    return { prepared, packet, material, assertCurrent };
  }

  async prepare(
    auth: AuthSession,
    clientId: string,
    group: string,
    raw: unknown,
    signal: AbortSignal,
  ) {
    const input = CollaborationForwardPrepareInputSchema.parse(raw);
    const actor = this.actor(auth, clientId, signal);
    actor();
    const previous = this.store.collaborationConversation.getRetainedForwardPreparation(
      group,
      input.selection.requestId,
    );
    if (previous) {
      this.provenance(auth, previous);
      if (!isDeepStrictEqual(previous.input, input))
        throw new CollaborationContractError('request_conflict');
      // Lost response recovery observes original metadata before mutable source reads.
      if (previous.serialized !== null)
        return this.store.collaborationConversation.readForward(
          group,
          previous.operatorId,
          previous.forwardId,
        );
    }
    const record =
      previous ??
      this.store.collaborationConversation.reserveForwardPreparation(group, {
        operatorId: auth.id,
        input,
      });
    const context = await this.compile(auth, group, record, signal, actor, true);
    return this.store.collaborationConversation.completeForwardPreparation(
      group,
      input.selection.requestId,
      {
        operatorId: record.operatorId,
        serialized: context.prepared.serialized,
        packetSha256: context.prepared.sha256,
      },
      context.assertCurrent,
    );
  }
  read(auth: AuthSession, clientId: string, group: string, forwardId: string) {
    const actor = this.actor(auth, clientId);
    actor();
    const record = this.store.collaborationConversation.getRetainedForward(group, forwardId);
    if (!record) throw new CollaborationContractError('not_found');
    this.provenance(auth, record);
    const result = this.store.collaborationConversation.readForward(
      group,
      record.operatorId,
      forwardId,
    );
    actor();
    return result;
  }
  observePreparation(auth: AuthSession, clientId: string, group: string, requestId: string) {
    const actor = this.actor(auth, clientId);
    actor();
    const record = this.store.collaborationConversation.getRetainedForwardPreparation(
      group,
      requestId,
    );
    if (!record) return null;
    this.provenance(auth, record);
    const result = this.store.collaborationConversation.readForward(
      group,
      record.operatorId,
      record.forwardId,
    );
    actor();
    return result;
  }
  async confirm(
    auth: AuthSession,
    clientId: string,
    group: string,
    raw: unknown,
    signal: AbortSignal,
  ) {
    const input = CollaborationForwardConfirmInputSchema.parse(raw);
    const actor = this.actor(auth, clientId, signal);
    actor();
    const record = this.store.collaborationConversation.getRetainedForward(
      group,
      input.forward.forwardId,
    );
    if (!record) throw new CollaborationContractError('not_found');
    this.provenance(auth, record);
    if (record.confirmation) {
      // The durable owner checks the exact original fingerprint. This callback
      // cannot authorize a new confirmation when observing an accepted receipt.
      return this.store.collaborationConversation.confirmForward(
        group,
        { operatorId: record.operatorId, input },
        () => {
          throw changed();
        },
      );
    }
    const context = await this.compile(auth, group, record, signal, actor, true);
    if (
      context.prepared.serialized !== record.serialized ||
      context.prepared.sha256 !== record.packetSha256
    )
      throw changed();
    return this.store.collaborationConversation.confirmForward(
      group,
      { operatorId: record.operatorId, input },
      context.assertCurrent,
    );
  }
  /** Internal pending delivery, independent of an attached viewer. The ordinary
   * dispatcher still owns current recipient authorization and command claims. */
  async delivery(
    auth: AuthSession,
    group: string,
    reference: { forwardId: string; packetSha256: string },
    recipients: string[],
    signal: AbortSignal,
  ) {
    const record = this.store.collaborationConversation.getForwardPacket(group, {
      forwardId: reference.forwardId,
      packetSha256: reference.packetSha256,
    });
    this.provenance(auth, record);
    if (!record.confirmation) throw changed();
    const context = await this.compile(
      auth,
      group,
      record,
      signal,
      () => this.provenance(auth, record),
      false,
      recipients,
    );
    if (
      context.prepared.serialized !== record.serialized ||
      context.prepared.sha256 !== reference.packetSha256
    )
      throw changed();
    return {
      packet: context.packet,
      material: context.material,
      assertCurrent: context.assertCurrent,
      assertRecipient: (id: string, settings: CollaborationSettings) => {
        context.assertCurrent();
        this.targets(group, record, false, [id]);
        if (!isDeepStrictEqual(record.settings[id], settings)) throw changed();
      },
    };
  }
  close() {
    this.retained?.close();
  }
}
