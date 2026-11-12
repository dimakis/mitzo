import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  CollaborationContractError,
  CollaborationMessageInputSchema,
  CollaborationForwardPacketSchema,
  type CollaborationProgress,
  type CollaborationMessage,
  type CollaborationSnapshot,
  type CollaborationSettings,
} from '@mitzo/protocol';
import { isAuthSessionCurrent, type AuthSession } from './auth.js';
import type { EventStore } from './event-store.js';
import type { OrdinarySessionPromptPort } from './session-prompt-dispatch.js';
import {
  OrdinaryCollaborationReplies,
  ordinaryReplySourceCommand,
} from './collaboration-ordinary-replies.js';
import { compileCollaborationContext } from './collaboration-context-compiler.js';
import { createCollaborationContextSource } from './collaboration-context-source.js';
import { createLogger } from './logger.js';
import { preparePromptContext } from './collaboration-prompt-context.js';
import { CollaborationApplicationForwarding } from './collaboration-application-forwarding.js';
import { ordinaryOperatorOwnsConversation } from './ordinary-operator-identity.js';
import { snapshotInputMaterial, forwardInputMaterial } from './collaboration-context-input.js';

const log = createLogger('collaboration-messaging');
const promptByteLimit = 512 * 1024;
type DiscussionMessage = Pick<CollaborationMessage, 'sequence' | 'author' | 'text' | 'source'> &
  Partial<Pick<CollaborationMessage, 'snapshot' | 'forward'>>;
type MessageContextReference =
  | {
      kind: 'snapshot';
      key: string;
      sha256: string;
      value: NonNullable<CollaborationMessage['snapshot']>;
    }
  | {
      kind: 'forward';
      key: string;
      sha256: string;
      value: NonNullable<CollaborationMessage['forward']>;
    };
type PreparedMessageContext = {
  sha256: string;
  material: unknown;
  assertCurrent(): void;
  assertRecipient(sessionId: string, settings: CollaborationSettings): void;
};
type PreparedMessageContexts = Map<string, PreparedMessageContext>;
function contextReference(
  message: Pick<DiscussionMessage, 'snapshot' | 'forward'>,
): MessageContextReference | undefined {
  if (message.snapshot && message.forward) throw new CollaborationContractError('snapshot_changed');
  if (message.snapshot)
    return {
      kind: 'snapshot',
      key: 'snapshot:' + message.snapshot.snapshotId,
      sha256: message.snapshot.sha256,
      value: message.snapshot,
    };
  if (message.forward)
    return {
      kind: 'forward',
      key: 'forward:' + message.forward.forwardId,
      sha256: message.forward.packetSha256,
      value: message.forward,
    };
}
function discussionMessage(message: DiscussionMessage, contexts: PreparedMessageContexts) {
  const reference = contextReference(message);
  return discussionMaterial(message, reference && contexts.get(reference.key));
}
// The preparation inventory uses the same encoder before retaining/compiling
// source witnesses. Raw material here grants no delivery or source capability.
function discussionMaterial(
  message: DiscussionMessage,
  context?: Pick<PreparedMessageContext, 'sha256' | 'material'>,
) {
  const reference = contextReference(message);
  if (reference && (!context || context.sha256 !== reference.sha256))
    throw new CollaborationContractError('snapshot_changed');
  return {
    sequence: message.sequence,
    author: message.author,
    text: message.text,
    source: message.source,
    ...(context && reference
      ? { [reference.kind === 'snapshot' ? 'sharedContext' : 'forwardedContext']: context.material }
      : {}),
  };
}

/** Composes group intent with the existing ordinary dispatcher. The collaboration
 * owns recipient receipts; the ordinary command ledger alone proves execution.
 * No reader, reply projection or retry can request an additional model turn. */
export class ApplicationCollaborationMessaging {
  constructor(
    private readonly store: EventStore,
    private readonly port: OrdinarySessionPromptPort,
    private readonly forwarding = new CollaborationApplicationForwarding(store),
  ) {}

  private current(auth: AuthSession, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!isAuthSessionCurrent(auth)) throw new CollaborationContractError('execution_unavailable');
  }

  async recipientReadiness(
    auth: AuthSession,
    group: string,
    sessionId: string,
    signal: AbortSignal,
  ) {
    this.current(auth, signal);
    const view = this.store.collaborationConversation.view(group);
    const result = (reason: string | null) => ({
      collaborationId: group,
      sessionId,
      membershipRevision: view.membershipRevision,
      policySequence: view.policySequence,
      ready: reason === null,
      reason,
    });
    try {
      if (
        !view.participantSessionIds.includes(sessionId) ||
        view.unavailableParticipantSessionIds.includes(sessionId)
      )
        return result(
          'This participant is unavailable. Refresh Agents and choose a current participant.',
        );
      if (!this.port.inspectCollaboration) return result('Ordinary group delivery is unavailable.');
      const settings = this.store.getOrdinaryConversationSettings(sessionId);
      if (
        !settings ||
        settings.binding.harness.implementation !== 'codex' ||
        settings.binding.execution.location !== 'local'
      )
        return result('Choose a repository-backed Local Codex participant.');
      const context = await this.joiningContext(auth, group, sessionId, settings, signal);
      const snapshots = await this.pendingPromptContexts(
        auth,
        group,
        new Map([[sessionId, settings]]),
        [sessionId],
        view.cursor,
        signal,
      );
      const history = this.pendingHistory(
        group,
        sessionId,
        view.cursor,
        context.snapshot,
        '',
        undefined,
        snapshots,
      );
      this.assertHistoryCurrent(group, history, sessionId, settings, undefined, snapshots);
      for (const reader of view.policies.filter(
        (p) => p.readsFutureDiscussion && p.sessionId !== sessionId,
      )) {
        const readerSettings = this.store.getOrdinaryConversationSettings(reader.sessionId);
        if (
          !readerSettings ||
          readerSettings.binding.harness.implementation !== 'codex' ||
          readerSettings.binding.execution.location !== 'local' ||
          view.unavailableParticipantSessionIds.includes(reader.sessionId)
        )
          return result(
            'Review discussion sharing in Agents. A context reader is unavailable on this route.',
          );
      }
      const preparation = this.store.getOrdinarySessionPreparationForConversation(sessionId);
      await this.port.inspectCollaboration({
        auth,
        sessionId,
        settings,
        commandId: 'readiness-only',
        text: '',
        ...(preparation?.firstCommandId === null
          ? { preparationOperationId: preparation.allocationOperationId }
          : {}),
      });
      context.assertCurrent();
      const current = this.store.collaborationConversation.view(group);
      if (
        current.membershipRevision !== view.membershipRevision ||
        current.policySequence !== view.policySequence ||
        !isDeepStrictEqual(this.store.getOrdinaryConversationSettings(sessionId), settings)
      )
        return result('The participant changed. Refresh before sending.');
      return result(null);
    } catch (cause) {
      this.current(auth, signal);
      log.warn('Could not verify collaboration recipient readiness', {
        err: cause,
        code: 'collaboration_recipient_readiness_failed',
        stage: 'recipient_readiness',
        collaborationId: group,
        sessionId,
      });
      return result(
        'The participant needs attention. Refresh Agents and review its account, context and ordinary session.',
      );
    }
  }

  /** Observe the original request and exact durable execution; never infer
   * completion from a disconnected transport or a missing assistant message. */
  observe(auth: AuthSession, group: string, raw: unknown) {
    this.current(auth);
    const input = CollaborationMessageInputSchema.parse(raw);
    this.reconcile(auth, group);
    const message = this.store.collaborationConversation.getMessageForRequest(group, input) ?? null;
    const replies = message?.deliveries.filter((d) => d.purpose === 'reply') ?? [];
    const terminal =
      replies.length > 0 &&
      replies.every((delivery) => {
        if (['failed', 'unavailable'].includes(delivery.status)) return true;
        // The retained receipt owns this observation after a participant leaves.
        // Its exact command may be terminal without allowing transcript reads
        // or a new dispatch to that now-unavailable recipient.
        if (!delivery.commandId) return false;
        const command = this.store.getSendCommand(delivery.commandId);
        if (command?.sessionId !== delivery.sessionId) return false;
        const outcome = this.port.observedOutcome?.(auth, delivery.sessionId, delivery.commandId);
        return !!outcome && outcome !== 'uncertain';
      });
    return { message, terminal };
  }

  async stop(auth: AuthSession, group: string, raw: unknown) {
    this.current(auth);
    const input = CollaborationMessageInputSchema.parse(raw);
    const message = this.store.collaborationConversation.getMessageForRequest(group, input);
    if (!message) throw new CollaborationContractError('not_found');
    const recipients = [];
    for (const delivery of message.deliveries) {
      if (delivery.purpose !== 'reply') continue;
      this.current(auth);
      let status: 'requested' | 'settled' | 'uncertain' | 'unavailable' = 'unavailable';
      if (['failed', 'unavailable'].includes(delivery.status)) status = 'settled';
      else if (delivery.commandId && this.port.stopOrdinary) {
        try {
          status = await this.port.stopOrdinary(
            auth,
            delivery.sessionId,
            delivery.commandId,
            `collaboration-stop:${delivery.deliveryId}`,
            () => this.current(auth),
          );
        } catch (cause) {
          this.current(auth);
          log.warn('Could not confirm the original collaboration Stop', {
            err: cause,
            code: 'collaboration_stop_uncertain',
            stage: 'ordinary_stop',
            collaborationId: group,
            sessionId: delivery.sessionId,
            commandId: delivery.commandId,
          });
          status = 'uncertain';
        }
      }
      recipients.push({ sessionId: delivery.sessionId, deliveryId: delivery.deliveryId, status });
    }
    this.current(auth);
    return { requestId: input.requestId, recipients };
  }

  private async joiningContext(
    auth: AuthSession,
    group: string,
    sessionId: string,
    settings: CollaborationSettings,
    signal: AbortSignal,
  ) {
    const join = this.store.collaborationConversation.getLinkedJoinForSession(group, sessionId);
    if (!join) return { snapshot: null, assertCurrent: () => this.current(auth, signal) };
    const snapshot = this.store.collaborationConversation.getSnapshot(
      group,
      join.snapshot.snapshotId,
    );
    const retained = this.store.collaborationConversation.getReviewCompilationForSnapshot(
      group,
      join.snapshot.snapshotId,
    );
    const assertCurrent = () => {
      this.current(auth, signal);
      const membership = this.store.getSessionCollaboration(group);
      const source = snapshot && this.store.getSession(snapshot.sourceConversationId);
      if (
        !snapshot ||
        snapshot.sha256 !== join.snapshot.sha256 ||
        !ordinaryOperatorOwnsConversation(retained?.operatorId, auth.id) ||
        !isDeepStrictEqual(join.settings, settings) ||
        !source ||
        source.isHidden ||
        !membership?.participantSessionIds.includes(sessionId) ||
        !membership.participantSessionIds.includes(snapshot.sourceConversationId)
      )
        throw new CollaborationContractError('snapshot_changed');
    };
    assertCurrent();
    const source = createCollaborationContextSource({
      store: this.store,
      authorizeConversation: async () => assertCurrent(),
      assertConversationCurrent: assertCurrent,
    });
    const compiled = await compileCollaborationContext(retained!.selection, [settings], source);
    const fields = [
      'sourceConversationId',
      'boundary',
      'mode',
      'purpose',
      'joiningBrief',
      'messages',
      'artifacts',
      'summary',
    ] as const;
    if (fields.some((key) => !isDeepStrictEqual(compiled[key], snapshot![key])))
      throw new CollaborationContractError('snapshot_changed');
    return {
      snapshot,
      assertCurrent: () => {
        assertCurrent();
        source.assertCurrentAtSave();
      },
    };
  }

  private receipt(
    group: string,
    message: CollaborationMessage,
    deliveryId: string,
    status: 'queued' | 'delivered' | 'uncertain',
    commandId: string,
    reason: string | null = null,
  ) {
    const current = this.store.collaborationConversation.getMessage(group, message.messageId)!;
    const delivery = current.deliveries.find((d) => d.deliveryId === deliveryId)!;
    if (delivery.status === status && delivery.commandId === commandId) return;
    this.store.collaborationConversation.recordDelivery(group, message.messageId, deliveryId, {
      requestId: randomUUID(),
      expectedRevision: delivery.revision,
      status,
      commandId,
      reason,
    });
  }

  async send(auth: AuthSession, group: string, raw: unknown, signal: AbortSignal) {
    this.current(auth, signal);
    const input = CollaborationMessageInputSchema.parse(raw);
    const retained = this.store.collaborationConversation.getMessageForRequest(group, input);
    if (retained) {
      this.reconcile(auth, group);
      return this.store.collaborationConversation.getMessage(group, retained.messageId)!;
    }
    const view = this.store.collaborationConversation.view(group);
    const responders =
      input.responders.kind === 'all'
        ? view.participantSessionIds
        : input.responders.kind === 'selected'
          ? input.responders.sessionIds
          : view.policies.filter((p) => p.repliesByDefault).map((p) => p.sessionId);
    if (!responders.length) throw new CollaborationContractError('no_responders');
    const readers = [
      ...new Set([
        ...responders,
        ...view.policies.filter((p) => p.readsFutureDiscussion).map((p) => p.sessionId),
      ]),
    ];
    const contexts = new Map<
      string,
      Awaited<ReturnType<ApplicationCollaborationMessaging['joiningContext']>>
    >();
    const settings = new Map<string, CollaborationSettings>();
    for (const sessionId of readers) {
      if (!view.participantSessionIds.includes(sessionId))
        throw new CollaborationContractError('unavailable_recipient');
      const current = this.store.getOrdinaryConversationSettings(sessionId);
      if (
        !current ||
        current.binding.harness.implementation !== 'codex' ||
        current.binding.execution.location !== 'local'
      )
        throw new CollaborationContractError('execution_unavailable');
      settings.set(sessionId, current);
      contexts.set(sessionId, await this.joiningContext(auth, group, sessionId, current, signal));
    }
    const snapshots = await this.pendingPromptContexts(
      auth,
      group,
      settings,
      responders,
      this.store.collaborationConversation.view(group).cursor,
      signal,
      input.snapshot ? { reference: input.snapshot, sessionIds: readers } : undefined,
    );
    if (input.snapshot) {
      const review = this.store.collaborationConversation.getReviewCompilationForSnapshot(
        group,
        input.snapshot.snapshotId,
      );
      if (
        review?.selection.expectedMembershipRevision !== view.membershipRevision ||
        review.promptAudience?.policySequence !== view.policySequence
      )
        throw new CollaborationContractError('snapshot_changed');
    }
    const assertCurrent = () => {
      this.current(auth, signal);
      const membership = this.store.getSessionCollaboration(group);
      if (
        membership?.revision !== view.membershipRevision ||
        this.store.collaborationConversation.view(group).policySequence !== view.policySequence
      )
        throw new CollaborationContractError('conflict');
      for (const [sessionId, selected] of settings) {
        if (!isDeepStrictEqual(this.store.getOrdinaryConversationSettings(sessionId), selected))
          throw new CollaborationContractError('snapshot_changed');
        contexts.get(sessionId)!.assertCurrent();
      }
      for (const snapshot of snapshots.values()) snapshot.assertCurrent();
    };
    assertCurrent();
    // Context compilation yields. An identical request may have been accepted
    // while this caller was preparing; observe its packet before applying the
    // distinct-request fan-out guard or attempting any new claims.
    const acceptedWhilePreparing = this.store.collaborationConversation.getMessageForRequest(
      group,
      input,
    );
    if (acceptedWhilePreparing) {
      this.reconcile(auth, group);
      return this.store.collaborationConversation.getMessage(
        group,
        acceptedWhilePreparing.messageId,
      )!;
    }
    // Renew the pending discussion after compilation awaits, before any message
    // or command mutation. Refuse an overfull packet without retaining a send.
    const pending = this.store.collaborationConversation.view(group);
    for (const sessionId of responders) {
      const history = this.pendingHistory(
        group,
        sessionId,
        pending.cursor,
        contexts.get(sessionId)!.snapshot,
        input.text,
        {
          sequence: pending.cursor + 1,
          author: 'operator',
          text: input.text,
          source: null,
          snapshot: input.snapshot,
        },
        snapshots,
      );
      // A prior fan-out may still be preparing another recipient. Never adopt
      // that recipient's explicit reply into this new command or leave a new
      // partially accepted message while the original intent is unclaimed.
      if (
        history.some((m) =>
          m.deliveries.some(
            (d) =>
              d.sessionId === sessionId &&
              d.purpose === 'reply' &&
              d.commandId === null &&
              d.status === 'pending',
          ),
        )
      )
        throw new CollaborationContractError('execution_unavailable');
      this.assertHistoryCurrent(
        group,
        history,
        sessionId,
        settings.get(sessionId)!,
        undefined,
        snapshots,
      );
    }
    const message = this.store.collaborationConversation.acceptMessage(group, input);
    for (const delivery of message.deliveries.filter((d) => d.purpose === 'reply')) {
      // Claim synchronously before the first await. Concurrent request replay can
      // observe this receipt but cannot dispatch another command. A crash in this
      // window stays uncertain; recovery never guesses that provider effects are absent.
      const current = this.store.collaborationConversation.getMessage(group, message.messageId)!;
      const original = current.deliveries.find((d) => d.deliveryId === delivery.deliveryId)!;
      if (original.commandId !== null) continue;
      const commandId = `collaboration:${delivery.deliveryId}`;
      assertCurrent();
      const snapshot = contexts.get(delivery.sessionId)!.snapshot;
      const history = this.pendingHistory(
        group,
        delivery.sessionId,
        message.sequence,
        snapshot,
        input.text,
        undefined,
        snapshots,
      );
      const assertHistoryCurrent = (requireClaim = false) => {
        assertCurrent();
        this.assertHistoryCurrent(
          group,
          history,
          delivery.sessionId,
          settings.get(delivery.sessionId)!,
          requireClaim ? commandId : undefined,
          snapshots,
        );
      };
      assertHistoryCurrent();
      const text = this.prompt(group, history, snapshot, input.text, snapshots);
      // Claim the complete packet synchronously. Another queued prompt must not
      // capture context whose delivery already belongs to this command.
      for (const shared of history) {
        const ref = shared.deliveries.find((d) => d.sessionId === delivery.sessionId)!;
        this.receipt(group, shared, ref.deliveryId, 'queued', commandId);
      }
      try {
        const preparation = this.store.getOrdinarySessionPreparationForConversation(
          delivery.sessionId,
        );
        await this.port.deliverOrdinary(
          {
            sessionId: delivery.sessionId,
            commandId,
            auth,
            text,
            settings: settings.get(delivery.sessionId)!,
            turnLifecycle: {
              beforeDispatch: () => assertHistoryCurrent(true),
              accepted: (acceptedId) => {
                if (acceptedId !== commandId)
                  throw new CollaborationContractError('reply_conflict');
                for (const shared of history) {
                  const ref = shared.deliveries.find((d) => d.sessionId === delivery.sessionId)!;
                  this.receipt(group, shared, ref.deliveryId, 'delivered', commandId);
                }
              },
              terminal: () => {},
            },
            ...(preparation?.firstCommandId === null
              ? { preparationOperationId: preparation.allocationOperationId }
              : {}),
          },
          signal,
          assertCurrent,
        );
      } catch (cause) {
        log.warn('Ordinary collaboration delivery needs reconciliation', {
          err: cause,
          code: 'collaboration_delivery_uncertain',
          stage: 'ordinary_delivery',
          collaborationId: group,
          sessionId: delivery.sessionId,
          commandId,
        });
        for (const shared of history) {
          const ref = this.store.collaborationConversation
            .getMessage(group, shared.messageId)!
            .deliveries.find((d) => d.sessionId === delivery.sessionId)!;
          if (ref.status !== 'delivered')
            this.receipt(
              group,
              shared,
              ref.deliveryId,
              'uncertain',
              commandId,
              'Check the original ordinary command; this request will not resend it.',
            );
        }
      }
    }
    this.reconcile(auth, group);
    return this.store.collaborationConversation.getMessage(group, message.messageId)!;
  }

  private async pendingPromptContexts(
    auth: AuthSession,
    group: string,
    settings: Map<string, CollaborationSettings>,
    recipients: string[],
    through: number,
    signal: AbortSignal,
    additional?: { reference: NonNullable<CollaborationMessage['snapshot']>; sessionIds: string[] },
  ) {
    const references = new Map<
      string,
      { reference: MessageContextReference; recipients: Set<string> }
    >();
    const include = (reference: MessageContextReference, recipient: string) => {
      const old = references.get(reference.key);
      if (old && old.reference.sha256 !== reference.sha256)
        throw new CollaborationContractError('snapshot_changed');
      const entry = old ?? { reference, recipients: new Set<string>() };
      entry.recipients.add(recipient);
      references.set(reference.key, entry);
    };
    for (const recipient of recipients) {
      let after = 0;
      let bytes = 0;
      for (;;) {
        this.current(auth, signal);
        const page = this.store.collaborationConversation.pendingDeliveryPage(
          group,
          recipient,
          after,
          through,
        );
        for (const message of page) {
          // Bound every recipient's complete retained material, including each
          // repeated reference, before compiling any unique source witness.
          // Keep at most one raw context at a time. The final packet check also
          // charges the wrapper, joining context and prospective prompt.
          const reference = contextReference(message);
          let context: Pick<PreparedMessageContext, 'sha256' | 'material'> | undefined;
          if (reference?.kind === 'snapshot') {
            const snapshot = this.store.collaborationConversation.getSnapshot(
              group,
              reference.value.snapshotId,
            );
            if (!snapshot) throw new CollaborationContractError('snapshot_changed');
            context = { sha256: snapshot.sha256, material: snapshotInputMaterial(snapshot) };
          } else if (reference?.kind === 'forward') {
            const saved = this.store.collaborationConversation.getForwardPacket(
              group,
              reference.value,
            );
            if (!ordinaryOperatorOwnsConversation(saved.operatorId, auth.id))
              throw new CollaborationContractError('execution_unavailable');
            context = {
              sha256: saved.packetSha256,
              material: forwardInputMaterial(
                CollaborationForwardPacketSchema.parse(JSON.parse(saved.serialized)),
              ),
            };
          }
          bytes +=
            Buffer.byteLength(JSON.stringify(discussionMaterial(message, context)), 'utf8') + 1;
          if (bytes > promptByteLimit) throw new CollaborationContractError('capacity_refused');
          after = message.sequence;
          if (reference) include(reference, recipient);
        }
        if (page.length < 50) break;
      }
    }
    for (const id of additional?.sessionIds ?? [])
      include(contextReference({ snapshot: additional!.reference })!, id);
    const prepared: PreparedMessageContexts = new Map();
    for (const [id, selected] of references) {
      const reference = selected.reference;
      let context: PreparedMessageContext;
      if (reference.kind === 'snapshot') {
        const snapshot = await preparePromptContext({
          store: this.store,
          auth,
          group,
          reference: reference.value,
          signal,
        });
        context = {
          ...snapshot,
          sha256: snapshot.snapshot.sha256,
          material: snapshotInputMaterial(snapshot.snapshot),
        };
      } else {
        const forward = await this.forwarding.delivery(
          auth,
          group,
          reference.value,
          [...selected.recipients],
          signal,
        );
        context = { ...forward, sha256: reference.sha256 };
      }
      for (const recipient of selected.recipients)
        context.assertRecipient(recipient, settings.get(recipient)!);
      context.assertCurrent();
      prepared.set(id, context);
    }
    return prepared;
  }

  private assertHistoryCurrent(
    group: string,
    history: CollaborationMessage[],
    sessionId: string,
    settings: CollaborationSettings,
    commandId?: string,
    snapshots: PreparedMessageContexts = new Map(),
  ) {
    for (const shared of history) {
      // Never replace retained material with its note or omit a reviewed source.
      const reference = contextReference(shared);
      if (reference) {
        const reviewed = snapshots.get(reference.key);
        if (!reviewed || reviewed.sha256 !== reference.sha256)
          throw new CollaborationContractError('snapshot_changed');
        reviewed.assertRecipient(sessionId, settings);
        reviewed.assertCurrent();
      }
      const ref = shared.deliveries.find((d) => d.sessionId === sessionId)!;
      this.store.collaborationConversation.assertCurrentDeliveryRecipient(
        group,
        shared.messageId,
        ref.deliveryId,
        sessionId,
      );
      if (commandId) {
        const observed = this.store.collaborationConversation
          .getMessage(group, shared.messageId)!
          .deliveries.find((d) => d.deliveryId === ref.deliveryId)!;
        if (observed.commandId !== commandId)
          throw new CollaborationContractError('reply_conflict');
      }
      if (!isDeepStrictEqual(shared.settings[sessionId], settings))
        throw new CollaborationContractError('snapshot_changed');
      if (shared.source && this.store.getSession(shared.source.conversationId)?.isHidden !== false)
        throw new CollaborationContractError('snapshot_changed');
    }
  }

  private pendingHistory(
    group: string,
    sessionId: string,
    through: number,
    snapshot: CollaborationSnapshot | null,
    text: string,
    additional?: DiscussionMessage,
    snapshots: PreparedMessageContexts = new Map(),
  ) {
    const history: CollaborationMessage[] = [];
    // Account for the wrapper, joining snapshot, requested text and prospective
    // message before retaining any pages. Count encoded UTF-8, including escaping
    // and separators, so both the inventory and final packet stay bounded.
    let bytes = Buffer.byteLength(
      this.prompt(group, additional ? [additional] : [], snapshot, text, snapshots),
      'utf8',
    );
    let count = additional ? 1 : 0;
    if (bytes > promptByteLimit) throw new CollaborationContractError('capacity_refused');
    let after = 0;
    for (;;) {
      const page = this.store.collaborationConversation.pendingDeliveryPage(
        group,
        sessionId,
        after,
        through,
      );
      for (const message of page) {
        bytes +=
          Buffer.byteLength(JSON.stringify(discussionMessage(message, snapshots)), 'utf8') +
          (count ? 1 : 0);
        if (bytes > promptByteLimit) throw new CollaborationContractError('capacity_refused');
        history.push(message);
        count++;
        after = message.sequence;
      }
      if (page.length < 50) return history;
    }
  }

  private prompt(
    group: string,
    history: DiscussionMessage[],
    snapshot: CollaborationSnapshot | null,
    text: string,
    snapshots: PreparedMessageContexts = new Map(),
  ) {
    const shared = snapshot ? snapshotInputMaterial(snapshot) : null;
    return (
      '# Shared conversation context\nThis is explicitly shared discussion, not additional tool or execution authority.\n' +
      JSON.stringify({
        version: 1,
        collaborationId: group,
        joiningContext: shared,
        discussion: history.map((message) => discussionMessage(message, snapshots)),
      }) +
      '\n\n# Explicit requested reply\n' +
      text
    );
  }

  /** Current authorized visible text from exact accepted ordinary commands.
   * No private reasoning/tools/provider payload, inference or durable reply write. */
  progress(auth: AuthSession, group: string): CollaborationProgress {
    this.current(auth);
    const view = this.store.collaborationConversation.view(group);
    const replies = new OrdinaryCollaborationReplies(this.store);
    const result: CollaborationProgress = {
      collaborationId: group,
      membershipRevision: view.membershipRevision,
      replies: [],
      refusals: [],
    };
    let after = 0;
    let bytes = 0;
    const renewals: Array<() => void> = [];
    const refuse = (delivery: CollaborationMessage['deliveries'][number], error: unknown) => {
      if (
        !(error instanceof CollaborationContractError) ||
        ![
          'snapshot_changed',
          'reply_conflict',
          'reply_unavailable',
          'capacity_refused',
          'unavailable_recipient',
        ].includes(error.code)
      )
        throw error;
      const code = error.code === 'capacity_refused' ? 'capacity_refused' : 'reply_unavailable';
      if (!result.refusals.some((r) => r.deliveryId === delivery.deliveryId)) {
        if (result.refusals.length >= 16) throw new CollaborationContractError('capacity_refused');
        result.refusals.push({
          deliveryId: delivery.deliveryId,
          sessionId: delivery.sessionId,
          code,
        });
      }
      log.warn('Could not project live collaboration text', {
        code,
        stage: 'reply_stream_projection',
        collaborationId: group,
        sessionId: delivery.sessionId,
        commandId: delivery.commandId,
      });
    };
    for (;;) {
      const page = this.store.collaborationConversation.messagesForReplyReconciliation(
        group,
        after,
        view.cursor,
      );
      for (const message of page) {
        after = message.sequence;
        for (const delivery of message.deliveries) {
          if (
            delivery.purpose !== 'reply' ||
            !delivery.commandId ||
            !view.participantSessionIds.includes(delivery.sessionId) ||
            view.unavailableParticipantSessionIds.includes(delivery.sessionId) ||
            this.store.getOrdinaryProviderTurnTerminal(delivery.sessionId, delivery.commandId)
          )
            continue;
          try {
            this.store.collaborationConversation.assertCurrentDeliveryRecipient(
              group,
              message.messageId,
              delivery.deliveryId,
              delivery.sessionId,
            );
            const settings = this.store.getOrdinaryConversationSettings(delivery.sessionId);
            if (!settings || !isDeepStrictEqual(message.settings[delivery.sessionId], settings))
              throw new CollaborationContractError('reply_conflict');
            for (const messageId of this.replySources(delivery.sessionId, delivery.commandId)) {
              try {
                const source = replies.streaming(delivery.sessionId, delivery.commandId, messageId);
                if (!source) continue;
                if (!isDeepStrictEqual(source.settings, settings))
                  throw new CollaborationContractError('reply_conflict');
                const key = createHash('sha256')
                  .update(`stream:${group}:${delivery.deliveryId}:${messageId}`)
                  .digest('hex');
                const item = {
                  projectionId: `${key.slice(0, 8)}-${key.slice(8, 12)}-4${key.slice(13, 16)}-8${key.slice(17, 20)}-${key.slice(20, 32)}`,
                  sourceMessageId: messageId,
                  deliveryId: delivery.deliveryId,
                  sessionId: delivery.sessionId,
                  text: source.text,
                };
                const size = Buffer.byteLength(JSON.stringify(item), 'utf8');
                if (result.replies.length >= 50 || bytes + size > promptByteLimit)
                  throw new CollaborationContractError('capacity_refused');
                result.replies.push(item);
                bytes += size;
                renewals.push(() => {
                  this.store.collaborationConversation.assertCurrentDeliveryRecipient(
                    group,
                    message.messageId,
                    delivery.deliveryId,
                    delivery.sessionId,
                  );
                  if (
                    currentView.unavailableParticipantSessionIds.includes(delivery.sessionId) ||
                    !isDeepStrictEqual(
                      this.store.getOrdinaryConversationSettings(delivery.sessionId),
                      settings,
                    )
                  )
                    throw new CollaborationContractError('reply_conflict');
                });
              } catch (error) {
                refuse(delivery, error);
              }
            }
          } catch (error) {
            refuse(delivery, error);
          }
        }
      }
      if (page.length < 50) break;
    }
    this.current(auth);
    const currentView = this.store.collaborationConversation.view(group);
    if (currentView.membershipRevision !== view.membershipRevision)
      throw new CollaborationContractError('conflict');
    for (const renew of renewals) renew();
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > promptByteLimit)
      throw new CollaborationContractError('capacity_refused');
    return result;
  }

  /** Read/restart reconciliation projects only finalized, privately mapped native
   * replies. No transport callback or public JSON can supply reply text/identity. */
  reconcile(auth: AuthSession, group: string) {
    this.current(auth);
    const replies = new OrdinaryCollaborationReplies(this.store);
    const view = this.store.collaborationConversation.view(group);
    let after = 0;
    for (;;) {
      const page = this.store.collaborationConversation.messagesForReplyReconciliation(
        group,
        after,
        view.cursor,
      );
      for (const message of page) {
        after = message.sequence;
        for (const delivery of message.deliveries) {
          if (delivery.purpose !== 'reply' || !delivery.commandId) continue;
          this.store.collaborationConversation.recordReplyOutcome(
            group,
            message.messageId,
            delivery.deliveryId,
            (sessionId, commandId) => this.port.observedOutcome?.(auth, sessionId, commandId),
          );
          // Historical receipts survive unlinking and hiding; never reopen a revoked source.
          if (
            !view.participantSessionIds.includes(delivery.sessionId) ||
            view.unavailableParticipantSessionIds.includes(delivery.sessionId)
          )
            continue;
          const command = this.store.getSendCommand(delivery.commandId);
          if (command?.sessionId !== delivery.sessionId || command.error) continue;
          for (const messageId of this.replySources(delivery.sessionId, delivery.commandId)) {
            try {
              const source = this.store.readOrdinaryFinalizedReply(delivery.sessionId, messageId);
              if (!source || !source.blocks.length) continue;
              if (
                ordinaryReplySourceCommand(this.store, delivery.sessionId, source.messageId) !==
                delivery.commandId
              )
                continue;
              const key = createHash('sha256')
                .update(`${group}:${delivery.deliveryId}:${source.messageId}`)
                .digest('hex');
              const requestId = `${key.slice(0, 8)}-${key.slice(8, 12)}-4${key.slice(13, 16)}-8${key.slice(17, 20)}-${key.slice(20, 32)}`;
              replies.record(group, {
                requestId,
                messageId: message.messageId,
                deliveryId: delivery.deliveryId,
                source: {
                  conversationId: delivery.sessionId,
                  commandId: delivery.commandId,
                  messageId: source.messageId,
                  throughSequence: source.sequence,
                  blockIds: source.blocks.map((b) => b.blockId),
                },
              });
              // The reply owner verifies the mapping's pinned execution before
              // promoting acceptance. Never consult ambiguous unpinned history.
              if (['queued', 'uncertain'].includes(delivery.status))
                this.receipt(group, message, delivery.deliveryId, 'delivered', delivery.commandId);
            } catch (error) {
              // Refuse just this retained source. Storage/programming failures remain observable.
              if (
                !(error instanceof CollaborationContractError) ||
                ![
                  'snapshot_changed',
                  'capacity_refused',
                  'reply_conflict',
                  'reply_unavailable',
                ].includes(error.code)
              )
                throw error;
              log.warn('Could not project finalized collaboration reply', {
                code: error.code,
                stage: 'reply_projection',
                collaborationId: group,
                sessionId: delivery.sessionId,
                commandId: delivery.commandId,
                messageId,
              });
            }
          }
        }
      }
      if (page.length < 50) break;
    }
  }

  private *replySources(sessionId: string, commandId: string) {
    let after = 0;
    for (;;) {
      const page = this.store.getOrdinaryReplySourcePage(sessionId, commandId, after);
      for (const row of page) {
        after = row.sequence;
        if (row.messageId) yield row.messageId;
      }
      if (page.length < 50) return;
    }
  }

  close() {
    this.port.close();
    this.forwarding.close();
  }
}
