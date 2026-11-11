import type { Session } from '../types/chat';
import { useConversationReadState } from '../hooks/useConversationReadState';
import '../styles/session-library.css';

export function ConversationUnreadDot({ session }: { session: Session }) {
  const { unread } = useConversationReadState(session.id, session.replyReadState);
  return (
    <span className="conversation-read-marker" aria-hidden={!unread || undefined}>
      {unread && (
        <span
          className="conversation-unread-dot"
          role="status"
          aria-label="Unread reply"
          title="Unread reply"
        />
      )}
    </span>
  );
}
