import type { CollaborationDelivery } from '@mitzo/protocol';
import type { CollaborationProjection } from '@mitzo/client';
import { conversationMessages } from '../lib/conversation-presentation';
import { ChatArea, type ChatAreaProps } from './ChatArea';
import { SeatLabel } from './SeatLabel';
import './ConversationAgents.css';
import './CollaborationTranscript.css';

type Props = Omit<
  ChatAreaProps,
  | 'sessionId'
  | 'messages'
  | 'current'
  | 'running'
  | 'permission'
  | 'onPermissionRespond'
  | 'renderMessageAttribution'
  | 'renderMessageOutcome'
> & {
  projection: CollaborationProjection;
  names?: Readonly<Record<string, string>>;
  onRefresh?(): void;
} & Partial<Pick<ChatAreaProps, 'current' | 'running' | 'permission' | 'onPermissionRespond'>>;

function receiptLabel(delivery: CollaborationDelivery) {
  if (delivery.status === 'uncertain') return 'Outcome uncertain · do not resend';
  if (delivery.purpose === 'context') {
    if (delivery.status === 'pending') return 'Context pending · no response requested';
    return {
      delivered: 'Context accepted',
      queued: 'Context queued',
      failed: 'Context failed',
      unavailable: 'Context unavailable',
    }[delivery.status];
  }
  return {
    pending: 'Prompt pending',
    delivered: 'Prompt accepted',
    queued: 'Prompt queued',
    failed: 'Prompt failed',
    unavailable: 'Prompt unavailable',
  }[delivery.status];
}

/** Actual collaboration schema -> ordinary transcript. This owns no reads, mutations or delivery.
 * Successful bodies remain visible independently of other recipients' receipts or refresh failures.
 */
export function CollaborationTranscript({
  projection,
  names = {},
  onRefresh,
  afterMessages,
  current = null,
  running = false,
  permission = null,
  onPermissionRespond = () => {},
  ...chat
}: Props) {
  const { view } = projection;
  const name = (id: string) => {
    const label = names[id] || `Agent · ${id}`;
    return names[id] &&
      Object.values(names).filter((other) => other.toLowerCase() === label.toLowerCase()).length > 1
      ? `${label} · ${id}`
      : label;
  };
  const messages = new Map(view.messages.map((message) => [message.projectionId, message]));
  return (
    <ChatArea
      {...chat}
      sessionId={view.collaborationId}
      messages={conversationMessages(view)}
      current={current}
      running={running}
      permission={permission}
      onPermissionRespond={onPermissionRespond}
      renderMessageAttribution={(id) => {
        const message = messages.get(id);
        if (!message || message.author === 'operator') return null;
        const sessionId = message.author.sessionId;
        const origin = view.messages.find((prompt) =>
          prompt.deliveries.some(
            (delivery) =>
              delivery.deliveryId === message.replyToDeliveryId &&
              delivery.sessionId === sessionId &&
              delivery.purpose === 'reply',
          ),
        );
        const settings = origin?.settings[sessionId];
        return (
          <details className="conversation-message-provenance">
            <summary
              className="chat-seat-attribution"
              aria-label={`Message details for ${name(sessionId)}`}
            >
              <strong>
                <SeatLabel seatId={sessionId} name={name(sessionId)} />
              </strong>
            </summary>
            <div className="conversation-message-provenance-details">
              <span>Session {sessionId}</span>
              <span>
                {settings
                  ? `${settings.binding.account.accountId} · ${settings.selection.model}`
                  : 'Original account and model not retained in this page'}
              </span>
            </div>
          </details>
        );
      }}
      renderMessageOutcome={(id) => {
        const message = messages.get(id);
        if (!message?.deliveries.length) return null;
        const readers = message.readers.filter((reader) => !message.responders.includes(reader));
        return (
          <details className="conversation-delivery-details">
            <summary>
              {[
                message.responders.length ? `To ${message.responders.map(name).join(', ')}` : '',
                readers.length ? `Context for ${readers.map(name).join(', ')}` : '',
              ]
                .filter(Boolean)
                .join(' · ')}
            </summary>
            <ul>
              {message.deliveries.map((delivery) => (
                <li key={delivery.deliveryId}>
                  <strong>{name(delivery.sessionId)}</strong>
                  <span>{receiptLabel(delivery)}</span>
                  {delivery.reason && <span>{delivery.reason}</span>}
                </li>
              ))}
            </ul>
          </details>
        );
      }}
      afterMessages={
        <>
          {view.hasEarlierMessages && (
            <p className="conversation-replay-status">
              Earlier messages are outside this retained page.
            </p>
          )}
          {projection.needsRefresh && (
            <div className="conversation-replay-status" role="status">
              <p>
                Refresh this conversation to check its latest state. Retained replies stay here.
              </p>
              {onRefresh && (
                <button type="button" className="home-btn home-btn-secondary" onClick={onRefresh}>
                  Refresh conversation
                </button>
              )}
            </div>
          )}
          {afterMessages}
        </>
      }
    />
  );
}
