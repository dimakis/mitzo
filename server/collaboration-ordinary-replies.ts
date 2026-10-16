import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  CollaborationContractError,
  CollaborationSettingsSchema,
  type CollaborationMessageSource,
} from '@mitzo/protocol';
import type { EventStore } from './event-store.js';

const id = z.string().min(1).max(200).regex(/^\S+$/);
const Source = z.strictObject({
  commandId: id,
  messageId: id,
  providerThreadId: id,
  providerTurnId: id,
});
const RetainedSource = Source.extend({ version: z.literal(1) });
type SourceStore = Pick<
  EventStore,
  'getSendCommand' | 'getOrdinaryCommandAdmission' | 'getOrdinaryReplySourceEvents' | 'append'
>;

function ordinaryCommand(store: SourceStore, sessionId: string, commandId: string) {
  const command = store.getSendCommand(commandId);
  const admission = store.getOrdinaryCommandAdmission(commandId);
  if (
    !command ||
    command.sessionId !== sessionId ||
    command.error ||
    !admission ||
    admission.binding.version !== 2 ||
    admission.binding.harness.implementation !== 'codex' ||
    admission.state === 'reserved'
  )
    throw new CollaborationContractError('reply_conflict');
  return admission;
}

/** Called only by the existing owned driver's exact provider-ACK observer.
 * This private event binds generated renderer identity, never provider text or credentials.
 */
export function recordOrdinaryReplySource(store: SourceStore, sessionId: string, raw: unknown) {
  const source = Source.parse(raw);
  ordinaryCommand(store, sessionId, source.commandId);
  const retained = store.getOrdinaryReplySourceEvents(sessionId, source.messageId);
  if (retained.length) {
    if (
      retained.length !== 1 ||
      !isDeepStrictEqual(RetainedSource.parse(retained[0]), { version: 1, ...source })
    )
      throw new CollaborationContractError('reply_conflict');
    return;
  }
  store.append(sessionId, 'ordinary_reply_source', { version: 1, ...source });
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
    const admission = ordinaryCommand(this.store, source.conversationId, source.commandId);
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
