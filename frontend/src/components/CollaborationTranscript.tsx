import type {
  CollaborationDelivery,
  CollaborationProgress,
  StreamingMessage,
} from '@mitzo/protocol';
import type { CollaborationProjection } from '@mitzo/client';
import { conversationMessages } from '../lib/conversation-presentation';
import { ChatArea, type ChatAreaProps } from './ChatArea';
import { SeatLabel } from './SeatLabel';
import './ConversationAgents.css';
import './CollaborationTranscript.css';

type Props = Omit<
  ChatAreaProps,
  | 'sessionId'
  | 'discoverTelosOrigins'
  | 'messages'
  | 'current'
  | 'running'
  | 'permission'
  | 'onPermissionRespond'
  | 'renderMessageAttribution'
  | 'renderMessageOutcome'
> & {
  projection?: CollaborationProjection;
  /** Original authorized rich source, using its ordinary identity and controls. */
  ordinary?: ChatAreaProps;
  names?: Readonly<Record<string, string>>;
  onRefresh?(): void;
  progress?: CollaborationProgress;
} & Partial<Pick<ChatAreaProps, 'current' | 'running' | 'permission' | 'onPermissionRespond'>>;

function receiptLabel(delivery: CollaborationDelivery) {
  if (delivery.purpose === 'reply' && delivery.outcome)
    return {
      completed: 'Reply completed',
      failed: 'Reply failed',
      interrupted: 'Reply stopped',
      uncertain: 'Outcome uncertain · do not resend',
    }[delivery.outcome];
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
  ordinary,
  names = {},
  onRefresh,
  progress,
  afterMessages,
  current = null,
  running = false,
  permission = null,
  onPermissionRespond = () => {},
  ...chat
}: Props) {
  // Keep the same ChatArea mounted before and after the first shared participant.
  if (!projection)
    return (
      <ChatArea
        {...(ordinary ?? { ...chat, messages: [] })}
        current={current}
        running={running}
        permission={permission}
        onPermissionRespond={onPermissionRespond}
        afterMessages={afterMessages}
      />
    );
  const { view } = projection;
  const name = (id: string) => {
    const label = names[id] || `Agent · ${id}`;
    return names[id] &&
      Object.values(names).filter((other) => other.toLowerCase() === label.toLowerCase()).length > 1
      ? `${label} · ${id}`
      : label;
  };
  const ordinaryMessages = ordinary?.messages ?? [];
  const displayedIds = new Map<string, string>();
  const claimed = new Set<string>();
  const sourceMatches = (
    source: { conversationId: string; messageId: string; commandId?: string },
    message: { messageId: string; replyToMessageId?: string },
  ) =>
    source.conversationId === ordinary?.sessionId &&
    source.messageId === message.messageId &&
    (!message.replyToMessageId ||
      !source.commandId ||
      source.commandId === message.replyToMessageId);
  const shared = conversationMessages(view).map((projected, index) => {
    const message = view.messages[index];
    const rich = ordinaryMessages.find((candidate) =>
      message.source
        ? sourceMatches(message.source, candidate)
        : message.author === 'operator' &&
          candidate.role === 'user' &&
          message.deliveries.some(
            (delivery) =>
              delivery.sessionId === ordinary?.sessionId &&
              delivery.commandId === candidate.messageId,
          ),
    );
    const id = rich?.messageId ?? projected.messageId;
    displayedIds.set(message.projectionId, id);
    if (rich) claimed.add(rich.messageId);
    return rich ?? projected;
  });
  const messages = new Map(
    view.messages.map((message) => [displayedIds.get(message.projectionId)!, message]),
  );
  const live =
    progress?.collaborationId === view.collaborationId &&
    progress.membershipRevision === view.membershipRevision
      ? progress
      : undefined;
  const streams: Record<string, StreamingMessage> = { ...ordinary?.currentByMessage };
  if (ordinary?.current) streams[ordinary.current.messageId] = ordinary.current;
  for (const [id, stream] of Object.entries(streams)) {
    if (view.messages.some((message) => message.source && sourceMatches(message.source, stream)))
      delete streams[id];
  }
  const liveSource = (reply: CollaborationProgress['replies'][number]) => ({
    conversationId: reply.sessionId,
    messageId: reply.sourceMessageId,
    commandId:
      view.messages
        .flatMap((message) => message.deliveries)
        .find(
          (delivery) =>
            delivery.deliveryId === reply.deliveryId && delivery.sessionId === reply.sessionId,
        )?.commandId ?? undefined,
  });
  const liveReplies =
    live?.replies.filter(
      (reply) =>
        view.participantSessionIds.includes(reply.sessionId) &&
        !view.unavailableParticipantSessionIds.includes(reply.sessionId) &&
        !ordinaryMessages.some((message) => sourceMatches(liveSource(reply), message)) &&
        !view.messages.some(
          (message) =>
            message.replyToDeliveryId === reply.deliveryId &&
            message.source?.conversationId === reply.sessionId &&
            message.source.messageId === reply.sourceMessageId,
        ),
    ) ?? [];
  for (const reply of liveReplies) {
    const rich = Object.values(streams).find((stream) => sourceMatches(liveSource(reply), stream));
    if (rich) {
      displayedIds.set(reply.projectionId, rich.messageId);
      continue;
    }
    const blockId = `${reply.projectionId}:text`;
    streams[reply.projectionId] = {
      messageId: reply.projectionId,
      blocks: new Map([
        [blockId, { blockId, blockType: 'text', content: reply.text, done: false }],
      ]),
      blockOrder: [blockId],
    };
  }
  return (
    <ChatArea
      {...chat}
      discoverTelosOrigins={ordinary ? undefined : false}
      sessionId={ordinary?.sessionId ?? view.collaborationId}
      preserveMessageOrder
      messageSessionId={(id) => messages.get(id)?.source?.conversationId ?? ordinary?.sessionId}
      messages={[
        ...ordinaryMessages.filter((message) => !claimed.has(message.messageId)),
        ...shared,
      ]}
      current={null}
      currentByMessage={streams}
      running={running}
      permission={permission}
      onPermissionRespond={onPermissionRespond}
      renderMessageAttribution={(id) => {
        const message = messages.get(id);
        const streaming = liveReplies.find(
          (reply) => (displayedIds.get(reply.projectionId) ?? reply.projectionId) === id,
        );
        const original =
          ordinaryMessages.some((message) => message.messageId === id) || !!streams[id];
        if (!streaming && (!message || message.author === 'operator'))
          return original &&
            ordinary?.sessionId &&
            ordinaryMessages.find((m) => m.messageId === id)?.role !== 'user' ? (
            <strong className="chat-seat-attribution">
              <SeatLabel seatId={ordinary.sessionId} name={name(ordinary.sessionId)} />
            </strong>
          ) : null;
        const sessionId =
          streaming?.sessionId ?? (message!.author as { sessionId: string }).sessionId;
        const origin = view.messages.find((prompt) =>
          prompt.deliveries.some(
            (delivery) =>
              delivery.deliveryId === (streaming?.deliveryId ?? message?.replyToDeliveryId) &&
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
        const failed = message.deliveries.filter(
          (delivery) =>
            delivery.purpose === 'reply' &&
            (delivery.outcome === 'failed' || ['failed', 'unavailable'].includes(delivery.status)),
        ).length;
        return (
          <details
            className="conversation-delivery-details"
            data-message-deliveries={message.projectionId}
          >
            <summary>
              {[
                message.responders.length ? `To ${message.responders.map(name).join(', ')}` : '',
                readers.length ? `Context for ${readers.map(name).join(', ')}` : '',
                failed
                  ? `${failed} ${failed === 1 ? 'recipient needs' : 'recipients need'} attention`
                  : '',
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
          {live?.refusals.map((refusal) => (
            <p role="alert" key={refusal.deliveryId}>
              {name(refusal.sessionId)}:{' '}
              {refusal.code === 'capacity_refused'
                ? 'The live reply is too large to display. Check the original request.'
                : 'The live reply could not be verified. Check the original request.'}
            </p>
          ))}
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
                <button type="button" className="home-secondary" onClick={onRefresh}>
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
