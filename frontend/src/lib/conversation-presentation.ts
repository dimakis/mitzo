import type {
  CollaborationMessageInput,
  CollaborationView,
  FinishedMessage,
  CollaborationMessage,
} from '@mitzo/protocol';
import type { ComposerResponderSelection } from '../components/ComposerResponders';

/** Display identity and order come from the shared projection, never a provider message ID.
 * Ordinary source cursors, timestamps and legacy seat provenance are not interchangeable.
 */
export function conversationMessages(view: CollaborationView): FinishedMessage[] {
  const prompts = new Map(
    view.messages.flatMap((message) =>
      message.deliveries
        .filter((delivery) => delivery.purpose === 'reply')
        .map((delivery) => [delivery.deliveryId, message] as const),
    ),
  );
  return view.messages.map((message) => {
    const original = message.replyToDeliveryId ? prompts.get(message.replyToDeliveryId) : undefined;
    const inReplyTo =
      message.inReplyTo ??
      (original
        ? {
            messageId: original.projectionId,
            role: conversationAuthor(original) ? ('assistant' as const) : ('user' as const),
            text: original.text,
            ...(original.recordedAt !== undefined ? { timestamp: original.recordedAt } : {}),
          }
        : undefined);
    return {
      messageId: message.projectionId,
      startedSeq: message.sequence,
      role: conversationAuthor(message) ? 'assistant' : 'user',
      ...(message.recordedAt !== undefined ? { timestamp: message.recordedAt } : {}),
      ...(inReplyTo ? { inReplyTo, replyToMessageId: inReplyTo.messageId } : {}),
      ...(message.images?.length
        ? { images: message.images.map((image) => `data:${image.mediaType};base64,${image.data}`) }
        : {}),
      blocks: [
        { blockId: `${message.projectionId}:text`, blockType: 'text', content: message.text },
      ],
    };
  });
}

export function conversationAuthor(message: CollaborationMessage): string | undefined {
  return (
    message.origin?.sessionId ??
    (message.author === 'operator' ? undefined : message.author.sessionId)
  );
}

/** Presentation only: resolving Defaults or changing a read policy cannot queue work. */
export function resolveConversationResponders(
  view: CollaborationView,
  responders: CollaborationMessageInput['responders'],
) {
  return responders.kind === 'all'
    ? [...view.participantSessionIds]
    : responders.kind === 'selected'
      ? [...responders.sessionIds]
      : view.policies.filter((policy) => policy.repliesByDefault).map((policy) => policy.sessionId);
}

export function conversationResponders(
  view: CollaborationView,
  responders: CollaborationMessageInput['responders'],
  names: Readonly<Record<string, string>> = {},
): Pick<ComposerResponderSelection, 'members' | 'selectedIds' | 'responders'> & {
  sendDisabledReason: string;
} {
  const members = view.participantSessionIds.map((id) => ({
    id,
    name: names[id] || `Agent · ${id}`,
    repliesByDefault: view.policies.some(
      (policy) => policy.sessionId === id && policy.repliesByDefault,
    ),
    ...(view.unavailableParticipantSessionIds.includes(id)
      ? { unavailableReason: 'Session unavailable' }
      : {}),
  }));
  return {
    members,
    responders,
    selectedIds: resolveConversationResponders(view, responders),
    // The actual protocol currently has no enabled execution variant. Never infer readiness.
    sendDisabledReason: view.execution.reason,
  };
}
