import type { MessageReplyContext } from '@mitzo/protocol';
import './ChatCommandMetadata.css';
export const REPLY_NAVIGATION_EVENT = 'mitzo:reply-navigation';
export function ReplyQuote({
  reply,
  author,
  sessionId,
  onNavigate,
}: {
  reply: MessageReplyContext;
  author?: string;
  sessionId?: string;
  onNavigate?(messageId: string, opener: HTMLButtonElement): void;
}) {
  return (
    <button
      type="button"
      className="chat-reply-link"
      aria-label={`Replying to: ${reply.text.slice(0, 120)}`}
      onClick={(event) => {
        if (onNavigate) onNavigate(reply.messageId, event.currentTarget);
        else
          window.dispatchEvent(
            new CustomEvent(REPLY_NAVIGATION_EVENT, {
              detail: { sessionId, messageId: reply.messageId, opener: event.currentTarget },
            }),
          );
      }}
    >
      <span className="chat-reply-author">
        {author ?? (reply.role === 'user' ? 'You' : 'Mitzo')}
      </span>
      {reply.timestamp != null && (
        <time dateTime={new Date(reply.timestamp).toISOString()}>
          {new Date(reply.timestamp).toLocaleString()}
        </time>
      )}
      <span className="chat-reply-excerpt">{reply.text}</span>
    </button>
  );
}
