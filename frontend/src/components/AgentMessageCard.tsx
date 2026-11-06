import type { AgentMessageProjection } from '@mitzo/protocol';
import { CopyButton } from './CopyButton';
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
  return (
    <article
      className="msg-turn agent-message-card"
      aria-label={direction === 'incoming' ? 'Agent message received' : 'Agent message sent'}
    >
      <strong>{direction === 'incoming' ? 'Agent message received' : 'Agent message sent'}</strong>
      <div className="agent-message-participants">
        <span>
          From{' '}
          <a href={`/chat/${encodeURIComponent(message.senderConversationId)}`}>{senderName}</a>
        </span>
        <span>
          To{' '}
          <a href={`/chat/${encodeURIComponent(message.recipientConversationId)}`}>
            {recipientName}
          </a>
        </span>
      </div>
      <div className="msg-bubble-content">{message.text}</div>
      <div className="agent-message-footer">
        <span role="status">{statuses[message.status]}</span>
        <time dateTime={new Date(projection.timestamp).toISOString()}>
          {new Date(projection.timestamp).toLocaleString()}
        </time>
        <CopyButton text={message.text} />
      </div>
      <details>
        <summary>Message details</summary>
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
