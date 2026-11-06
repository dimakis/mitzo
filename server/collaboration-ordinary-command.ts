import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  CollaborationContractError,
  type AccountBinding,
  type CollaborationJoin,
} from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { CodexConversationStore } from './codex-conversation-store.js';

export const collaborationCommandId = (deliveryId: string) => `collaboration:${deliveryId}`;
function unavailable(): never {
  throw new CollaborationContractError('execution_unavailable');
}

/** Renew the retained visible source synchronously. This runs again at native
 * enqueue/turn boundaries, including warm sends and explicit restart/Continue.
 * Nothing is summarized, expanded through a second runtime, or silently dropped. */
export function collaborationJoiningContext(
  store: EventStore,
  group: string,
  join: CollaborationJoin,
  operatorId: string,
) {
  const snapshot = store.collaborationConversation.getSnapshot(group, join.snapshot.snapshotId);
  const review = store.collaborationConversation.getReviewCompilationForSnapshot(
    group,
    join.snapshot.snapshotId,
  );
  const source = snapshot && store.getSession(snapshot.sourceConversationId);
  if (
    !snapshot ||
    snapshot.sha256 !== join.snapshot.sha256 ||
    !review ||
    review.operatorId !== operatorId ||
    !isDeepStrictEqual(review.settings, [join.settings]) ||
    !source ||
    source.isHidden ||
    source.sessionType === 'symposium' ||
    source.symposiumConfig ||
    !store.getSessionCollaboration(group)?.participantSessionIds.includes(source.sessionId) ||
    !['ready', 'unverified'].includes(snapshot.capacity.status)
  )
    unavailable();
  store.removals.assertAdmissible(source.sessionId);
  const visible = store.openCollaborationVisibleSource(source.sessionId, snapshot.boundary);
  if (
    !isDeepStrictEqual(
      visible.readSelected(snapshot.messages.map((row) => row.messageId)),
      snapshot.messages,
    )
  )
    unavailable();
  visible.assertCurrent();
  for (const pin of snapshot.artifacts) {
    const output = store.getSessionOutput(source.sessionId, pin.artifactId);
    if (
      !output ||
      output.sourceAvailability !== 'available' ||
      output.provenance ||
      output.revision !== pin.revision ||
      output.source.sha256 !== pin.sha256 ||
      pin.contentBase64 === undefined
    )
      unavailable();
    const { content } = store.readSessionOutput(source.sessionId, pin.artifactId);
    const bytes = Buffer.from(content, 'utf8');
    if (
      bytes.toString('base64') !== pin.contentBase64 ||
      createHash('sha256').update(bytes).digest('hex') !== pin.sha256
    )
      unavailable();
  }
  return {
    snapshotId: snapshot.snapshotId,
    sha256: snapshot.sha256,
    sourceConversationId: snapshot.sourceConversationId,
    boundary: snapshot.boundary,
    purpose: snapshot.purpose,
    joiningBrief: snapshot.joiningBrief,
    messages: snapshot.messages,
    artifacts: snapshot.artifacts,
    summary: snapshot.summary,
  };
}

export function collaborationCommandPayload(
  context: ReturnType<typeof collaborationJoiningContext>,
  text: string,
) {
  return {
    text: `# Reviewed joining context\n${JSON.stringify(context)}\n\n# Explicit group prompt\n${text}`,
    intent: text,
  };
}

/** A reserved collaboration command cannot run through an ordinary fallback
 * without its original ledger/source/settings. This observes existing owners;
 * it creates no capability, queue or second delivery ledger. */
export function assertCollaborationCommand(
  store: EventStore,
  sessionId: string,
  commandId: string,
  operatorId: string | undefined,
) {
  if (!commandId.startsWith('collaboration:')) return;
  const record = store.collaborationConversation.deliveryForCommand(commandId);
  if (
    !record ||
    !operatorId ||
    collaborationCommandId(record.delivery.deliveryId) !== commandId ||
    record.delivery.sessionId !== sessionId ||
    record.delivery.purpose !== 'reply' ||
    !['uncertain', 'queued'].includes(record.delivery.status)
  )
    unavailable();
  store.removals.assertAdmissible(sessionId);
  store.collaborationConversation.assertCurrentDeliveryRecipient(
    record.group,
    record.message.messageId,
    record.delivery.deliveryId,
    sessionId,
  );
  const join = store.collaborationConversation.linkedJoinForSession(record.group, sessionId);
  const session = store.getSession(sessionId);
  const settings = store.getOrdinaryConversationSettings(sessionId);
  if (
    !join ||
    !session ||
    session.isHidden ||
    session.sessionType === 'symposium' ||
    session.symposiumConfig ||
    !settings ||
    settings.binding.harness.implementation !== 'codex' ||
    settings.binding.execution.location !== 'local' ||
    !isDeepStrictEqual(settings, join.settings) ||
    !isDeepStrictEqual(settings, record.message.settings[sessionId])
  )
    unavailable();
  const payload = collaborationCommandPayload(
    collaborationJoiningContext(store, record.group, join, operatorId),
    record.message.text,
  );
  const command = store.getSendCommand(commandId);
  if (command) {
    // Ordinary admission adds only its own boot guidance. Every externally
    // selected input field must still equal the accepted text-only group input.
    const sharedPayload = { ...command.payload };
    delete sharedPayload.systemPrompt;
    if (command.sessionId !== sessionId || !isDeepStrictEqual(sharedPayload, payload))
      unavailable();
  }
}

export function reconcileCollaborationCommandAcceptance(
  store: EventStore,
  native: CodexConversationStore,
  sessionId: string,
  account: AccountBinding,
  commandId: string,
) {
  const command = store.getSendCommand(commandId);
  if (!command || command.sessionId !== sessionId || typeof command.payload?.text !== 'string')
    return;
  const accepted = native.acceptedProviderTurnForCommand(
    sessionId,
    account,
    commandId,
    command.payload.text,
    typeof command.payload.intent === 'string' ? command.payload.intent : command.payload.text,
  );
  if (accepted)
    recordCollaborationCommandAcceptance(
      store,
      native,
      sessionId,
      account,
      commandId,
      accepted.threadId,
      accepted.turnId,
    );
}

/** Exact native ACK observation only. It repairs public receipt state after
 * restart without reauthorizing a new turn or reopening mutable source content. */
export function recordCollaborationCommandAcceptance(
  store: EventStore,
  native: CodexConversationStore,
  sessionId: string,
  account: AccountBinding,
  commandId: string,
  threadId: string,
  turnId: string,
) {
  if (!commandId.startsWith('collaboration:')) return;
  const record = store.collaborationConversation.deliveryForCommand(commandId);
  const command = store.getSendCommand(commandId);
  if (
    !record ||
    !command ||
    typeof command.payload?.text !== 'string' ||
    record.delivery.sessionId !== sessionId
  )
    unavailable();
  const accepted = native.acceptedProviderTurnForCommand(
    sessionId,
    account,
    commandId,
    command.payload.text,
    typeof command.payload.intent === 'string' ? command.payload.intent : command.payload.text,
  );
  if (accepted?.threadId !== threadId || accepted.turnId !== turnId) unavailable();
  if (record.delivery.status === 'delivered') return;
  store.collaborationConversation.recordDelivery(
    record.group,
    record.message.messageId,
    record.delivery.deliveryId,
    {
      requestId: randomUUID(),
      expectedRevision: record.delivery.revision,
      status: 'delivered',
      commandId,
      reason: null,
    },
  );
}
