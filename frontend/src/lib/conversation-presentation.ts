import type {
  CollaborationMessageInput,
  CollaborationView,
  FinishedMessage,
} from '@mitzo/protocol';
import type { ComposerResponderSelection } from '../components/ComposerResponders';

/** Display identity and order come from the shared projection, never a provider message ID.
 * Ordinary source cursors, timestamps and legacy seat provenance are not interchangeable.
 */
export function conversationMessages(view: CollaborationView): FinishedMessage[] {
  return view.messages.map((message) => ({
    messageId: message.projectionId,
    startedSeq: message.sequence,
    role: message.author === 'operator' ? 'user' : 'assistant',
    blocks: [{ blockId: `${message.projectionId}:text`, blockType: 'text', content: message.text }],
  }));
}

/** Presentation only: resolving Defaults or changing a read policy cannot queue work. */
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
    selectedIds:
      responders.kind === 'all'
        ? [...view.participantSessionIds]
        : responders.kind === 'selected'
          ? [...responders.sessionIds]
          : members.filter((member) => member.repliesByDefault).map((member) => member.id),
    // The actual protocol currently has no enabled execution variant. Never infer readiness.
    sendDisabledReason: view.execution.reason,
  };
}
