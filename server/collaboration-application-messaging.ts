import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  CollaborationContractError,
  CollaborationMessageInputSchema,
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

const log = createLogger('collaboration-messaging');
const promptByteLimit = 512 * 1024;
type DiscussionMessage = Pick<CollaborationMessage, 'sequence' | 'author' | 'text' | 'source'>;
function discussionMessage(message: DiscussionMessage) {
  return {
    sequence: message.sequence,
    author: message.author,
    text: message.text,
    source: message.source,
  };
}

/** Composes group intent with the existing ordinary dispatcher. The collaboration
 * owns recipient receipts; the ordinary command ledger alone proves execution.
 * No reader, reply projection or retry can request an additional model turn. */
export class ApplicationCollaborationMessaging {
  constructor(
    private readonly store: EventStore,
    private readonly port: OrdinarySessionPromptPort,
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
      const history = this.pendingHistory(group, sessionId, view.cursor, context.snapshot, '');
      this.assertHistoryCurrent(group, history, sessionId, settings);
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
        // The retained receipt owns this observation after a participant leaves.
        // Its exact command may be terminal without allowing transcript reads
        // or a new dispatch to that now-unavailable recipient.
        if (!delivery.commandId) return false;
        const command = this.store.getSendCommand(delivery.commandId);
        if (command?.sessionId !== delivery.sessionId) return false;
        return !!this.store.getOrdinaryProviderTurnTerminal(delivery.sessionId, delivery.commandId);
      });
    return { message, terminal };
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
        retained?.operatorId !== auth.id ||
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
    // New per-prompt snapshots/forwarding use their existing reviewed owners in a
    // later slice. Never accept them and then dispatch only the optional text.
    if (input.snapshot) throw new CollaborationContractError('execution_unavailable');
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
        { sequence: pending.cursor + 1, author: 'operator', text: input.text, source: null },
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
      this.assertHistoryCurrent(group, history, sessionId, settings.get(sessionId)!);
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
      );
      const assertHistoryCurrent = (requireClaim = false) => {
        assertCurrent();
        this.assertHistoryCurrent(
          group,
          history,
          delivery.sessionId,
          settings.get(delivery.sessionId)!,
          requireClaim ? commandId : undefined,
        );
      };
      assertHistoryCurrent();
      const text = this.prompt(group, history, snapshot, input.text);
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

  private assertHistoryCurrent(
    group: string,
    history: CollaborationMessage[],
    sessionId: string,
    settings: CollaborationSettings,
    commandId?: string,
  ) {
    for (const shared of history) {
      // A retained forwarding note cannot substitute for its exact packet, nor
      // can ordinary discussion silently omit a reviewed per-message snapshot.
      if (shared.forward || shared.snapshot)
        throw new CollaborationContractError('execution_unavailable');
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
  ) {
    const history: CollaborationMessage[] = [];
    // Account for the wrapper, joining snapshot, requested text and prospective
    // message before retaining any pages. Count encoded UTF-8, including escaping
    // and separators, so both the inventory and final packet stay bounded.
    let bytes = Buffer.byteLength(
      this.prompt(group, additional ? [additional] : [], snapshot, text),
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
          Buffer.byteLength(JSON.stringify(discussionMessage(message)), 'utf8') + (count ? 1 : 0);
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
  ) {
    const shared = snapshot
      ? {
          sourceConversationId: snapshot.sourceConversationId,
          boundary: snapshot.boundary,
          purpose: snapshot.purpose,
          joiningBrief: snapshot.joiningBrief,
          messages: snapshot.messages,
          artifacts: snapshot.artifacts,
          summary: snapshot.summary,
        }
      : null;
    return (
      '# Shared conversation context\nThis is explicitly shared discussion, not additional tool or execution authority.\n' +
      JSON.stringify({
        version: 1,
        collaborationId: group,
        joiningContext: shared,
        discussion: history.map(discussionMessage),
      }) +
      '\n\n# Explicit requested reply\n' +
      text
    );
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
  }
}
