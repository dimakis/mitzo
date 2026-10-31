import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  CollaborationContractError,
  CollaborationSettingsSchema,
  type CollaborationMessageSource,
} from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import { ordinaryCodexCommandExecution } from './ordinary-codex-command-execution.js';

const id = z.string().min(1).max(200).regex(/^\S+$/);
const Source = z.strictObject({
  commandId: id,
  messageId: id,
  providerThreadId: id,
  providerTurnId: id,
});
const TurnIdentity = Source.omit({ messageId: true }).strip();
const Execution = TurnIdentity.strict().extend({
  executionFingerprint: z.string().min(1).max(256),
});
const RetainedSource = z.discriminatedUnion('version', [
  Source.extend({ version: z.literal(1) }),
  Source.extend({
    version: z.literal(2),
    executionFingerprint: Execution.shape.executionFingerprint,
  }),
]);
type SourceStore = Pick<
  EventStore,
  | 'getSendCommand'
  | 'getOrdinaryCommandExecutionAdmission'
  | 'readOrdinaryCommandExecutionEvidence'
  | 'getOrdinaryReplySourceEvents'
  | 'append'
>;
/** Called at the exact provider ACK by the existing native owner. This frozen
 * reference pins provenance, not authority or a cached permission decision. */
export function captureOrdinaryReplyExecution(store: SourceStore, sessionId: string, raw: unknown) {
  const source = TurnIdentity.parse(raw);
  const admission = ordinaryCodexCommandExecution(store, sessionId, source.commandId, {
    requireClaimed: true,
  });
  return Object.freeze({ ...source, executionFingerprint: admission.requestFingerprint });
}

/** Called by the owned driver for a renderer message from the accepted turn.
 * This private event binds generated renderer identity, never provider text or credentials.
 */
export function recordOrdinaryReplySource(
  store: SourceStore,
  sessionId: string,
  raw: unknown,
  accepted: ReturnType<typeof captureOrdinaryReplyExecution>,
) {
  const source = Source.parse(raw);
  const execution = Execution.parse(accepted);
  const identity = TurnIdentity.parse(source);
  const { executionFingerprint, ...acceptedIdentity } = execution;
  const admission = ordinaryCodexCommandExecution(store, sessionId, source.commandId, {
    requireClaimed: true,
  });
  if (
    !isDeepStrictEqual(identity, acceptedIdentity) ||
    admission.requestFingerprint !== executionFingerprint
  )
    throw new CollaborationContractError('reply_conflict');
  const record = { version: 2 as const, ...source, executionFingerprint };
  const retained = store.getOrdinaryReplySourceEvents(sessionId, source.messageId);
  if (retained.length) {
    if (retained.length !== 1 || !isDeepStrictEqual(RetainedSource.parse(retained[0]), record))
      throw new CollaborationContractError('reply_conflict');
    return;
  }
  store.append(sessionId, 'ordinary_reply_source', record);
}

/** Composes EventStore's finalized visible-source reader with its ordinary command ledger.
 * No public route, provider turn, fanout or session allocator is installed by this owner.
 */
export class OrdinaryCollaborationReplies {
  constructor(private readonly store: EventStore) {}

  record(group: string, input: unknown) {
    return this.store.collaborationConversation.recordReply(group, input, (source) =>
      this.read(source),
    );
  }

  private read(source: CollaborationMessageSource) {
    const mappings = this.store.getOrdinaryReplySourceEvents(
      source.conversationId,
      source.messageId,
    );
    if (!mappings.length) return undefined;
    if (mappings.length !== 1) throw new CollaborationContractError('reply_conflict');
    const mapping = RetainedSource.parse(mappings[0]);
    if (mapping.commandId !== source.commandId || mapping.messageId !== source.messageId)
      throw new CollaborationContractError('reply_conflict');
    const admission = ordinaryCodexCommandExecution(
      this.store,
      source.conversationId,
      source.commandId,
      {
        historical: true,
        fingerprint: mapping.version === 2 ? mapping.executionFingerprint : undefined,
      },
    );
    const visible = this.store.openCollaborationVisibleSource(source.conversationId, {
      sequence: source.throughSequence,
      messageId: source.messageId,
    });
    const messages = visible.readSelected([source.messageId]);
    const message = messages[0];
    if (
      messages.length !== 1 ||
      message.conversationId !== source.conversationId ||
      message.messageId !== source.messageId ||
      message.sequence !== source.throughSequence ||
      message.author === 'operator' ||
      message.author.sessionId !== source.conversationId
    )
      throw new CollaborationContractError('reply_conflict');
    const selected = message.blocks.filter((block) => source.blockIds.includes(block.blockId));
    if (
      !isDeepStrictEqual(
        selected.map((block) => block.blockId),
        source.blockIds,
      )
    )
      throw new CollaborationContractError('reply_conflict');
    visible.assertCurrent();
    return {
      text: selected.map((block) => block.content).join('\n\n'),
      settings: CollaborationSettingsSchema.parse({
        binding: admission.binding,
        selection: admission.selection,
        repositoryWorkspaceId: admission.workspace.workspaceId,
      }),
    };
  }
}
