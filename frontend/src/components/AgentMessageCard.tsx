import type { AgentMessageProjection } from '@mitzo/protocol';
import { usePeerChatName } from '../hooks/usePeerChatName';
import { CopyButton } from './CopyButton';
import { UiIcon } from './UiIcon';
import './AgentMessageCard.css';

const statuses = {
  pending: 'Sending — not delivered',
  uncertain: 'Delivery unconfirmed',
  queued: 'Queued — not delivered',
  delivered: 'Delivered to agent',
  unavailable: 'Recipient unavailable',
  failed: 'Delivery failed',
};

export function AgentMessageCard({ projection }: { projection: AgentMessageProjection }) {
  const { message, direction, senderName, recipientName } = projection;
  const incoming = direction === 'incoming';
  const remoteId = incoming ? message.senderConversationId : message.recipientConversationId;
  const remote = usePeerChatName(remoteId, incoming ? senderName : recipientName);
  const long = message.text.length > 700;
  return (
    <article
      className="msg-turn agent-message-card conversation-event"
      data-reply-source={message.commandId}
      tabIndex={-1}
      aria-label={direction === 'incoming' ? 'Agent message received' : 'Agent message sent'}
    >
      <span className="sr-only">{incoming ? 'Agent message received' : 'Agent message sent'}</span>
      <div className="agent-message-heading">
        <UiIcon name={incoming ? 'left' : 'right'} size={16} />
        <span>{incoming ? 'Received from' : 'Sent to'}</span>
        <time
          dateTime={new Date(projection.timestamp).toISOString()}
          title={new Date(projection.timestamp).toLocaleString()}
        >
          {new Date(projection.timestamp).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </time>
      </div>
      <a className="agent-message-chat" href={`/chat/${encodeURIComponent(remoteId)}`}>
        {remote.name} <UiIcon name="arrowUpRight" size={16} />
      </a>
      {remote.failed && (
        <p className="workspace-muted">Chat name unavailable. Showing the last known name.</p>
      )}
      <div className="msg-bubble-content">
        {long ? `${message.text.slice(0, 400)}…` : message.text}
      </div>
      {long && (
        <details>
          <summary>Read full message</summary>
          <div className="msg-bubble-content">{message.text}</div>
        </details>
      )}
      <div className="agent-message-footer">
        <span role="status">{statuses[message.status]}</span>
        <CopyButton text={message.text} />
      </div>
      <details>
        <summary>Message details</summary>
        <p>
          From {senderName} · To {recipientName}
        </p>
        <p>
          Sender chat ID: <code>{message.senderConversationId}</code>
        </p>
        <p>
          Recipient chat ID: <code>{message.recipientConversationId}</code>
        </p>
        <p>{new Date(projection.timestamp).toLocaleString()}</p>
        <p>
          Message ID: <code>{message.messageId}</code>
        </p>
        {message.replyTo && (
          <p>
            Reply to: <code>{message.replyTo}</code>
          </p>
        )}
        {message.reason && <p>Reason: {message.reason.replaceAll('_', ' ')}</p>}
      </details>
    </article>
  );
}
