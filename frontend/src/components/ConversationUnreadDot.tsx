import type { Session } from '../types/chat';
import { useConversationReadState } from '../hooks/useConversationReadState';
import '../styles/session-library.css';

export function ConversationUnreadDot({
  session,
  hydrate = false,
}: {
  session: Session;
  hydrate?: boolean;
}) {
  const { unread, error } = useConversationReadState(session.id, session.replyReadState, hydrate);
  if (error)
    return (
      <span role="status" title="Retry read status in conversation actions">
        Read status unavailable
      </span>
    );
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
