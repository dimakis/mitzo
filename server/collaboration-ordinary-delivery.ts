import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  CollaborationContractError,
  CollaborationSettingsSchema,
  CollaborationSnapshotSchema,
  type CollaborationSettings,
} from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { CodexConversationOptions } from './codex-conversation.js';

const id = z.string().min(1).max(200).regex(/^\S+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const reference = z.strictObject({
  collaborationId: z.uuid(),
  messageId: z.uuid(),
  deliveryId: z.uuid(),
});
const StageInput = z.strictObject({
  sessionId: id,
  commandId: id,
  deliveries: z.array(reference).min(1).max(500),
});
const Stage = z.strictObject({
  version: z.literal(1),
  commandId: id,
  settings: CollaborationSettingsSchema,
  deliveries: z
    .array(reference.extend({ receiptRequestId: z.uuid() }))
    .min(1)
    .max(500),
  context: z.string(),
  contextSha256: digest,
});
const Prepared = z.strictObject({
  version: z.literal(1),
  commandId: id,
  stagedContextSha256: digest,
  contextSha256: digest,
});
const Accepted = Prepared.extend({ providerThreadId: id, providerTurnId: id });
type Ref = z.infer<typeof reference>;
type Snapshot = z.infer<typeof CollaborationSnapshotSchema>;
type AcceptedIdentity = {
  sessionId: string;
  commandId: string;
  providerThreadId: string;
  providerTurnId: string;
};
export interface OrdinaryCollaborationDeliveryAuthority {
  /** Host-owned access/source/capacity fence, invoked at the actual ordinary admission barrier.
   * Frozen snapshot metadata is not an access grant or native capacity witness.
   */
  authorize(
    input: {
      sessionId: string;
      commandId: string;
      settings: CollaborationSettings;
      deliveries: Ref[];
      snapshots: Snapshot[];
    },
    signal: AbortSignal,
  ): Promise<void>;
  /** Synchronous current-authority/source epoch fence after all native preparation awaits. */
  assertBeforeDispatch(input: {
    sessionId: string;
    commandId: string;
    settings: CollaborationSettings;
    deliveries: Ref[];
  }): void;
  /** Must check the ordinary driver's exact native ACK receipt; never caller JSON. */
  assertProviderAccepted(identity: AcceptedIdentity): void;
}
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
function conflict(): never {
  throw new CollaborationContractError('reply_conflict');
}

/** A context/receipt adapter for existing ordinary commands, never a dispatcher.
 * Reading alone leaves the collaboration's durable pending receipt untouched. Only
 * an explicit admitted ordinary command may claim it, and only its exact native
 * ACK may project delivery. Native approvals, Stop and recovery retain their owners.
 */
export class OrdinaryCollaborationDelivery {
  constructor(
    private readonly store: EventStore,
    private readonly authority: OrdinaryCollaborationDeliveryAuthority,
  ) {}

  private command(sessionId: string, commandId: string, requireClaimed = false) {
    const command = this.store.getSendCommand(commandId);
    const admission = this.store.getOrdinaryCommandAdmission(commandId);
    if (
      !command ||
      command.sessionId !== sessionId ||
      command.error ||
      !admission ||
      admission.binding.version !== 2 ||
      admission.binding.harness.implementation !== 'codex' ||
      (requireClaimed && admission.state === 'reserved')
    )
      conflict();
    return CollaborationSettingsSchema.parse({
      binding: admission.binding,
      selection: admission.selection,
      repositoryWorkspaceId: admission.workspace.workspaceId,
    });
  }

  private ledger(sessionId: string, commandId: string) {
    const events = this.store.getOrdinaryCollaborationDeliveryEvents(sessionId, commandId);
    const read = <T>(type: string, schema: z.ZodType<T>): T | undefined => {
      const matching = events.filter((event) => event.type === type);
      if (matching.length > 1) conflict();
      return matching.length ? schema.parse(matching[0].payload) : undefined;
    };
    const staged = read('ordinary_collaboration_context_staged', Stage);
    const prepared = read('ordinary_collaboration_context_prepared', Prepared);
    const accepted = read('ordinary_collaboration_context_accepted', Accepted);
    if (
      (staged && hash(staged.context) !== staged.contextSha256) ||
      (prepared && (!staged || prepared.stagedContextSha256 !== staged.contextSha256)) ||
      (accepted &&
        (!prepared ||
          !isDeepStrictEqual(
            {
              version: accepted.version,
              commandId: accepted.commandId,
              stagedContextSha256: accepted.stagedContextSha256,
              contextSha256: accepted.contextSha256,
            },
            prepared,
          )))
    )
      conflict();
    return { staged, prepared, accepted };
  }

  private resolve(sessionId: string, commandId: string, refs: Ref[]) {
    const settings = this.command(sessionId, commandId);
    const snapshots: Snapshot[] = [];
    let replyOrigins = 0;
    const contents = refs
      .map((ref) => {
        const group = this.store.getSessionCollaboration(ref.collaborationId);
        const session = this.store.getSession(sessionId);
        if (
          !group?.participantSessionIds.includes(sessionId) ||
          !session ||
          session.isHidden ||
          session.sessionType === 'symposium' ||
          session.symposiumConfig ||
          !isDeepStrictEqual(this.store.getSessionRuntimeBinding(sessionId), settings.binding) ||
          session.repositoryWorkspaceId !== settings.repositoryWorkspaceId
        )
          conflict();
        const message = this.store.collaborationConversation.getMessage(
          ref.collaborationId,
          ref.messageId,
        );
        const delivery = message?.deliveries.find((row) => row.deliveryId === ref.deliveryId);
        if (
          !message ||
          !delivery ||
          delivery.sessionId !== sessionId ||
          !message.readers.includes(sessionId) ||
          !['pending', 'queued', 'uncertain'].includes(delivery.status) ||
          (delivery.commandId !== null && delivery.commandId !== commandId) ||
          !isDeepStrictEqual(message.settings[sessionId], settings)
        )
          conflict();
        if (delivery.purpose === 'reply' && ++replyOrigins > 1) conflict();
        let snapshot: Snapshot | null = null;
        if (message.snapshot) {
          snapshot = this.store.collaborationConversation.getSnapshot(
            ref.collaborationId,
            message.snapshot.snapshotId,
          );
          if (
            !snapshot ||
            snapshot.sha256 !== message.snapshot.sha256 ||
            snapshot.capacity.status !== 'ready' ||
            !snapshot.capacity.assessments.some((entry) =>
              isDeepStrictEqual(entry.settings, settings),
            )
          )
            throw new CollaborationContractError('snapshot_changed');
          snapshots.push(snapshot);
        }
        return {
          ...ref,
          purpose: delivery.purpose,
          sequence: message.sequence,
          message: { author: message.author, text: message.text, source: message.source },
          snapshot: snapshot
            ? {
                snapshotId: snapshot.snapshotId,
                sha256: snapshot.sha256,
                sourceConversationId: snapshot.sourceConversationId,
                boundary: snapshot.boundary,
                purpose: snapshot.purpose,
                joiningBrief: snapshot.joiningBrief,
                messages: snapshot.messages,
                artifacts: snapshot.artifacts,
                summary: snapshot.summary,
              }
            : null,
        };
      })
      .sort(
        (a, b) => a.collaborationId.localeCompare(b.collaborationId) || a.sequence - b.sequence,
      );
    const context = `# Shared conversation discussion\n${JSON.stringify({ version: 1, deliveries: contents })}`;
    if (Buffer.byteLength(context, 'utf8') > 512 * 1024)
      throw new CollaborationContractError('capacity_refused');
    return { settings, context, snapshots };
  }

  stage(raw: unknown): void {
    const input = StageInput.parse(raw);
    input.deliveries.sort((a, b) => a.deliveryId.localeCompare(b.deliveryId));
    if (new Set(input.deliveries.map((entry) => entry.deliveryId)).size !== input.deliveries.length)
      conflict();
    const old = this.ledger(input.sessionId, input.commandId).staged;
    // Exact retries after delivery/restart retain the original immutable claims.
    if (old) {
      const refs = old.deliveries.map(({ receiptRequestId: _requestId, ...ref }) => ref);
      if (
        !isDeepStrictEqual(refs, input.deliveries) ||
        !isDeepStrictEqual(old.settings, this.command(input.sessionId, input.commandId))
      )
        conflict();
      return;
    }
    const resolved = this.resolve(input.sessionId, input.commandId, input.deliveries);
    this.store.recordOrdinaryCollaborationDeliveryEvent(
      input.sessionId,
      input.commandId,
      'ordinary_collaboration_context_staged',
      Stage.parse({
        version: 1,
        commandId: input.commandId,
        settings: resolved.settings,
        deliveries: input.deliveries.map((ref) => ({ ...ref, receiptRequestId: randomUUID() })),
        context: resolved.context,
        contextSha256: hash(resolved.context),
      }),
    );
  }

  async prepareSystemPrompt(
    sessionId: string,
    commandId: string,
    baseContext: string | undefined,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const { staged, accepted } = this.ledger(sessionId, commandId);
    if (!staged) return baseContext;
    if (accepted) conflict(); // An acknowledged ordinary command must never dispatch again.
    signal.throwIfAborted();
    if (!isDeepStrictEqual(this.command(sessionId, commandId, true), staged.settings)) conflict();
    const refs = staged.deliveries.map(({ receiptRequestId: _requestId, ...ref }) => ref);
    const resolved = this.resolve(sessionId, commandId, refs);
    if (
      resolved.context !== staged.context ||
      !isDeepStrictEqual(resolved.settings, staged.settings)
    )
      conflict();
    await this.authority.authorize(
      {
        sessionId,
        commandId,
        settings: structuredClone(staged.settings),
        deliveries: structuredClone(refs),
        snapshots: structuredClone(resolved.snapshots),
      },
      signal,
    );
    signal.throwIfAborted();
    // Access checks may await external stores. Fence local settings/source changes again.
    const current = this.resolve(sessionId, commandId, refs);
    if (current.context !== staged.context || !isDeepStrictEqual(current.settings, staged.settings))
      conflict();
    const context =
      baseContext === undefined ? staged.context : `${baseContext}\n\n${staged.context}`;
    this.store.recordOrdinaryCollaborationDeliveryEvent(
      sessionId,
      commandId,
      'ordinary_collaboration_context_prepared',
      Prepared.parse({
        version: 1,
        commandId,
        stagedContextSha256: staged.contextSha256,
        contextSha256: hash(context),
      }),
    );
    return context;
  }

  accepted(
    sessionId: string,
    commandId: string,
    providerThreadId: string,
    providerTurnId: string,
    exactContext: string,
  ): void {
    const { staged, prepared } = this.ledger(sessionId, commandId);
    if (!staged) {
      const command = this.store.getSendCommand(commandId);
      if (command && command.sessionId !== sessionId) conflict();
      return;
    }
    if (
      !prepared ||
      hash(exactContext) !== prepared.contextSha256 ||
      !isDeepStrictEqual(this.command(sessionId, commandId, true), staged.settings)
    )
      conflict();
    const receipt = Accepted.parse({ ...prepared, providerThreadId, providerTurnId });
    this.authority.assertProviderAccepted({
      sessionId,
      commandId,
      providerThreadId,
      providerTurnId,
    });
    // Acceptance must survive a crash before any public recipient receipt is written.
    this.store.recordOrdinaryCollaborationDeliveryEvent(
      sessionId,
      commandId,
      'ordinary_collaboration_context_accepted',
      receipt,
    );
    this.recover(sessionId, commandId);
  }

  beforeDispatch(sessionId: string, commandId: string): void {
    const { staged, prepared, accepted } = this.ledger(sessionId, commandId);
    if (!staged) return;
    if (
      !prepared ||
      accepted ||
      !isDeepStrictEqual(this.command(sessionId, commandId, true), staged.settings)
    )
      conflict();
    const refs = staged.deliveries.map(({ receiptRequestId: _requestId, ...ref }) => ref);
    const resolved = this.resolve(sessionId, commandId, refs);
    if (
      resolved.context !== staged.context ||
      !isDeepStrictEqual(resolved.settings, staged.settings)
    )
      conflict();
    this.authority.assertBeforeDispatch({
      sessionId,
      commandId,
      settings: structuredClone(staged.settings),
      deliveries: structuredClone(refs),
    });
  }

  recover(sessionId: string, commandId: string): void {
    const { staged, accepted } = this.ledger(sessionId, commandId);
    if (!staged || !accepted) return;
    // Durable exact ACK effects do not re-open sources or reauthorize a new turn.
    for (const ref of staged.deliveries) {
      const message = this.store.collaborationConversation.getMessage(
        ref.collaborationId,
        ref.messageId,
      );
      const delivery = message?.deliveries.find((row) => row.deliveryId === ref.deliveryId);
      if (
        !delivery ||
        delivery.sessionId !== sessionId ||
        (delivery.commandId !== null && delivery.commandId !== commandId)
      )
        conflict();
      if (delivery.status === 'delivered') {
        if (delivery.commandId !== commandId) conflict();
        continue;
      }
      if (!['pending', 'queued', 'uncertain'].includes(delivery.status)) conflict();
      this.store.collaborationConversation.recordDelivery(
        ref.collaborationId,
        ref.messageId,
        ref.deliveryId,
        {
          requestId: ref.receiptRequestId,
          expectedRevision: delivery.revision,
          status: 'delivered',
          commandId,
          reason: null,
        },
      );
    }
  }
}

type ContextHooks = Pick<
  CodexConversationOptions,
  'prepareSystemPrompt' | 'onApplicationContextAccepted' | 'onProviderDispatch'
>;
/** Compose only at the existing native context/ACK boundary, preserving original owners. */
export function ordinaryCollaborationContextHooks(
  sessionId: string,
  delivery: OrdinaryCollaborationDelivery | undefined,
  existing: ContextHooks,
): ContextHooks {
  const prepare = existing.prepareSystemPrompt;
  const accepted = existing.onApplicationContextAccepted;
  const beforeDispatch = existing.onProviderDispatch;
  if (!delivery)
    return {
      prepareSystemPrompt: prepare,
      onApplicationContextAccepted: accepted,
      onProviderDispatch: beforeDispatch,
    };
  const contexts = new Map<string, { base: string | undefined; combined: string | undefined }>();
  return {
    prepareSystemPrompt: async (signal, turn) => {
      const base = await prepare?.(signal, turn);
      if (!turn) return base;
      const combined = await delivery.prepareSystemPrompt(sessionId, turn.commandId, base, signal);
      contexts.set(turn.commandId, { base, combined });
      return combined;
    },
    onProviderDispatch: (commandId) => {
      delivery.beforeDispatch(sessionId, commandId);
      beforeDispatch?.(commandId);
    },
    onApplicationContextAccepted: (commandId, threadId, turnId, context) => {
      const prepared = contexts.get(commandId);
      if (!prepared || context !== prepared.combined) conflict();
      if (prepared.base !== undefined) accepted?.(commandId, threadId, turnId, prepared.base);
      delivery.accepted(sessionId, commandId, threadId, turnId, context);
      contexts.delete(commandId);
    },
  };
}
