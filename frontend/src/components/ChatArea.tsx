import './ChatCommandMetadata.css';
import { useTelosCreatedItems } from '../hooks/useTelosCreatedItems';
import { TelosCreatedItemCard } from './TelosCreatedItemCard';
import { matchesTelosSourceBoundary } from '../lib/telos-source-boundary';
import { useTelosSourceNavigation } from '../hooks/useTelosSourceNavigation';
import { SeatLabel } from './SeatLabel';
import { UiIcon } from './UiIcon';
import { CompactionMarker } from './CompactionMarker';
import type { ContextCompaction } from '@mitzo/protocol';
import { seatAccentColor } from '../lib/seat-color';
import { useCallback, useEffect, useMemo, useRef, useState, Fragment, type ReactNode } from 'react';
import { UserBubble, TextBubble } from './MessageBubble';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolPill } from './ToolPill';
import { telosWorkerReceipt } from './TelosWorkerReceiptCard';
import { AgentActivity } from './AgentActivity';
import { completedWebsiteRead } from '../lib/web-access-outcome';
import { PermissionBanner } from './PermissionBanner';
import { ProgressWidget } from './ProgressWidget';
import { groupActivityRows, type ActivityRow } from '../lib/groupActivityRows';
import type { ChatBlock } from '../lib/groupMessages';
import { SCROLL_NEAR_BOTTOM_PX } from '../lib/constants';
import type { FinishedMessage, StreamingMessage, PermissionRequest } from '../types/chat';
import type { ProgressBlock } from '@mitzo/protocol';
import type { SymposiumProvenance } from '@mitzo/protocol';
import { progressToolLookupKey } from '@mitzo/client';
import type { UseVoiceReturn } from '../hooks/useVoice';

export type ChatAreaVoice = Pick<
  UseVoiceReturn,
  'ttsAvailable' | 'speak' | 'stopSpeaking' | 'speaking'
>;

export interface SymposiumContextItem {
  eventSeq: number;
  deliveryId: string;
  attemptId: number;
  recipientSeatId: string;
  sourceSeatId: string | null;
  sourceMessageId: string | null;
  content: string;
  receipt: 'received' | 'uncertain';
}

export interface ChatAreaProps {
  compactions?: ContextCompaction[];
  sessionId?: string;
  /** Only ordinary conversation identities may discover durable Telos origins. */
  discoverTelosOrigins?: boolean;
  messages: FinishedMessage[];
  current: StreamingMessage | null;
  currentByMessage?: Record<string, StreamingMessage>;
  contextItems?: SymposiumContextItem[];
  /** Presentation-only metadata keyed by the displayed message identity. */
  renderMessageAttribution?(messageId: string): ReactNode;
  renderMessageOutcome?(messageId: string): ReactNode;
  /** Source-bound previews for shared messages; ordinary callers use sessionId. */
  messageSessionId?(messageId: string): string | undefined;
  /** Additional transcript cards inside the same scroll area. */
  afterMessages?: ReactNode;
  onShareMessage?: (messageId: string, provenance?: SymposiumProvenance) => void;
  canShareMessage?: (message: FinishedMessage) => boolean;
  shareInActions?: boolean;
  compactAttribution?: boolean;
  running: boolean;
  permission: PermissionRequest | null;
  onPermissionExpire?: (permId: string) => void;
  onPermissionRespond: (
    permId: string,
    decision: 'once' | 'always' | 'deny',
    toolName: string,
    answers?: import('@mitzo/protocol').QuestionAnswers,
  ) => void;
  /** External ref for scroll container — caller can use for forceScrollToBottom */
  scrollRef?: React.RefObject<HTMLDivElement | null>;
  /** Progress blocks indexed by toolId for ordinary turns or seat/message/tool for Symposium. */
  progressByToolId?: Record<string, ProgressBlock>;
  /** Voice capabilities for per-block read-aloud */
  voice?: ChatAreaVoice;
}

function SeatAttribution({
  provenance,
  compact = false,
}: {
  provenance?: SymposiumProvenance;
  compact?: boolean;
}) {
  if (!provenance) return null;
  if (!('version' in provenance) || (provenance.version !== 2 && provenance.version !== 3)) {
    return (
      <div className="chat-seat-attribution">
        <SeatLabel
          seatId={provenance.seatId}
          name={`${provenance.seatId.charAt(0).toUpperCase() + provenance.seatId.slice(1)} seat · account and model unknown`}
        />
      </div>
    );
  }
  if (compact)
    return (
      <details className="conversation-message-provenance">
        <summary
          className="chat-seat-attribution"
          aria-label={`Message details for ${provenance.seatLabel}`}
        >
          <strong>
            <SeatLabel seatId={provenance.seatId} name={provenance.seatLabel} />
          </strong>
          <span>{provenance.seatRole}</span>
        </summary>
        <div className="conversation-message-provenance-details">
          <span>{provenance.accountBinding.accountLabel}</span>
          <span>{provenance.accountBinding.model}</span>
          <span>{provenance.reasoningEffort ?? 'effort unspecified'}</span>
          {provenance.version === 3 && (
            <span>Artifact {provenance.artifact.artifactGenerationId}</span>
          )}
        </div>
      </details>
    );
  return (
    <div className="chat-seat-attribution" aria-label={`Seat ${provenance.seatLabel}`}>
      <strong>
        <SeatLabel seatId={provenance.seatId} name={provenance.seatLabel} />
      </strong>
      <span>{provenance.seatRole}</span>
      <span>{provenance.accountBinding.accountLabel}</span>
      <span>{provenance.accountBinding.model}</span>
      <span>{provenance.reasoningEffort ?? 'effort unspecified'}</span>
      {provenance.version === 3 && <span>Artifact {provenance.artifact.artifactGenerationId}</span>}
    </div>
  );
}

function turnKey(messageId: string, provenance?: SymposiumProvenance): string {
  return provenance
    ? `symposium:${JSON.stringify([provenance.seatId, provenance.membershipGeneration ?? null, messageId])}`
    : messageId;
}

export function ChatArea({
  compactions = [],
  sessionId,
  discoverTelosOrigins = true,
  messages,
  current,
  currentByMessage = {},
  contextItems = [],
  afterMessages,
  renderMessageAttribution,
  renderMessageOutcome,
  messageSessionId,
  onShareMessage,
  canShareMessage,
  shareInActions = false,
  compactAttribution = false,
  running,
  permission,
  onPermissionRespond,
  onPermissionExpire,
  scrollRef: externalScrollRef,
  progressByToolId,
  voice,
}: ChatAreaProps) {
  const internalScrollRef = useRef<HTMLDivElement>(null);
  const scrollRef = externalScrollRef ?? internalScrollRef;
  const prevMessageCount = useRef(0);
  const requests = useMemo(
    () =>
      new Map(
        messages
          .filter((message) => message.role === 'user' && !message.symposiumProvenance)
          .map((message) => [message.messageId, message]),
      ),
    [messages],
  );
  const commandLabels: Record<string, string> = {
    sending: 'Sending…',
    queued: 'Queued — waiting for the current turn',
    running: 'Agent is answering',
    completed: 'Response complete',
    ended: 'Turn ended',
    interrupted: 'Turn stopped',
    failed: 'Turn failed',
    cancelled: 'Cancelled',
    steering: 'Sending correction…',
    steered: 'Correction sent to current turn',
    uncertain: 'Correction delivery not confirmed',
  };
  function replyLabel(message: FinishedMessage | StreamingMessage) {
    if (message.symposiumProvenance || !message.replyToMessageId) return null;
    const original = requests.get(message.replyToMessageId);
    const text = original?.blocks.find((block) => block.blockType === 'text')?.content;
    if (!text) return <div className="chat-command-meta">Answering an earlier message</div>;
    const label = `Answering: ${text.length > 120 ? text.slice(0, 120) + '…' : text}`;
    return (
      <button
        type="button"
        className="chat-reply-link"
        aria-label={label}
        onClick={() => {
          const target = Array.from(
            scrollRef.current?.querySelectorAll<HTMLElement>('[data-command-request]') ?? [],
          ).find((element) => element.dataset.commandRequest === message.replyToMessageId);
          target?.scrollIntoView({ block: 'center' });
          target?.focus({ preventScroll: true });
        }}
      >
        <UiIcon name="back" size={16} />
        <span>{label}</span>
      </button>
    );
  }
  const source = useTelosSourceNavigation();
  const sourceAnchor = (message: FinishedMessage) => {
    if (source?.status !== 'ready' || source.conversationId !== sessionId) return false;
    return matchesTelosSourceBoundary(message, source.packet!);
  };
  const createdItems = useTelosCreatedItems(discoverTelosOrigins ? sessionId : undefined);
  function createdItemCards(message: FinishedMessage) {
    if (!discoverTelosOrigins || !sessionId) return null;
    // The explicit inspected snapshot stays with its own validation owner;
    // ordinary discovery must not override a pending or unavailable inspection.
    const items = createdItems.filter(
      (item) => !source || item.itemId !== source.itemId || item.snapshotId !== source.snapshotId,
    );
    if (
      source?.status === 'ready' &&
      source.conversationId === sessionId &&
      source.packet?.creation
    )
      items.push({ itemId: source.itemId, snapshotId: source.snapshotId, packet: source.packet });
    return items
      .filter((item) => matchesTelosSourceBoundary(message, item.packet))
      .map((item) => (
        <TelosCreatedItemCard key={JSON.stringify([item.itemId, item.snapshotId])} item={item} />
      ));
  }
  const restoredBoundary = messages.find(sourceAnchor);
  // Only visible public text can anchor a finished assistant. Historical blank
  // or activity-only boundaries retain their normal rendering without owning
  // ordinary scrolling. A pending or not-yet-restored boundary still owns it.
  const unanchorableBoundary =
    restoredBoundary?.role === 'assistant' &&
    !restoredBoundary.blocks.some((block) => block.blockType === 'text' && block.content?.trim());
  const sourceKey =
    source && source.status !== 'unavailable' && !unanchorableBoundary
      ? JSON.stringify([source.conversationId, source.itemId, source.snapshotId])
      : '';
  const prevSourceKey = useRef(sourceKey);
  const jumpedSource = useRef('');
  useEffect(() => {
    if (!sourceKey) {
      jumpedSource.current = '';
      return;
    }
    if (source?.status !== 'ready' || jumpedSource.current === sourceKey) return;
    const anchor = scrollRef.current?.querySelector<HTMLElement>(
      '[data-telos-source-anchor="true"]',
    );
    if (!anchor) return;
    shouldFollowStreamRef.current = false;
    anchor.scrollIntoView({ block: 'start' });
    jumpedSource.current = sourceKey;
  }, [sourceKey, source, messages, scrollRef]);
  // Keep the reader's intent independently of the DOM height. By the time an
  // effect runs for a streamed chunk, the new content is already in the DOM,
  // so measuring then can incorrectly decide that a reader who scrolled up is
  // still close enough to the bottom to follow.
  const shouldFollowStreamRef = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const updateFollowState = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      shouldFollowStreamRef.current = distanceFromBottom <= SCROLL_NEAR_BOTTOM_PX;
    };

    updateFollowState();
    el.addEventListener('scroll', updateFollowState, { passive: true });
    return () => el.removeEventListener('scroll', updateFollowState);
  }, [scrollRef]);

  // Async work context can resize the transcript after session restore. Keep
  // following only when the reader already chose to follow; a retained source
  // boundary and a reader scrolled away from the bottom remain authoritative.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (!sourceKey && shouldFollowStreamRef.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [scrollRef, sourceKey]);

  // Track which block is currently being read aloud
  const [speakingBlockId, setSpeakingBlockId] = useState<string | null>(null);

  // Clear speakingBlockId when voice stops
  useEffect(() => {
    if (voice && !voice.speaking) {
      setSpeakingBlockId(null);
    }
    // Only re-run when the speaking boolean changes, not when the voice object reference changes
  }, [voice?.speaking]); // eslint-disable-line react-hooks/exhaustive-deps

  const speakBlock = useCallback(
    (blockId: string, text: string) => {
      if (!voice) return;
      setSpeakingBlockId(blockId);
      voice.speak(text);
    },
    [voice],
  );

  const stopBlock = useCallback(() => {
    if (!voice) return;
    voice.stopSpeaking();
    setSpeakingBlockId(null);
  }, [voice]);

  // Scroll to bottom on session restore (messages jump from 0 to N)
  useEffect(() => {
    const wasEmpty = prevMessageCount.current === 0;
    const releasedSource = !!prevSourceKey.current && !sourceKey;
    prevMessageCount.current = messages.length;
    prevSourceKey.current = sourceKey;
    if (
      messages.length > 0 &&
      !sourceKey &&
      (wasEmpty || (releasedSource && shouldFollowStreamRef.current))
    ) {
      shouldFollowStreamRef.current = true;
      let frame = requestAnimationFrame(() => {
        if (!shouldFollowStreamRef.current) return;
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
        // Restoring a deferred source can reveal the existing scroll controls.
        // Settle their viewport change without overriding newer reader intent.
        if (releasedSource)
          frame = requestAnimationFrame(() => {
            if (shouldFollowStreamRef.current)
              scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
          });
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [messages, scrollRef, sourceKey]);

  // Auto-scroll during streaming only while the reader has chosen to follow it.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && (!sourceKey || jumpedSource.current === sourceKey) && shouldFollowStreamRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, current, currentByMessage, scrollRef, sourceKey]);

  const progressFor = useCallback(
    (messageId: string, provenance: SymposiumProvenance | undefined, toolId?: string) =>
      toolId ? progressByToolId?.[progressToolLookupKey(messageId, toolId, provenance)] : undefined,
    [progressByToolId],
  );
  const orderedTurns = useMemo(() => {
    const turns = [
      ...messages.map((value, index) => ({
        kind: 'finished' as const,
        value,
        startedSeq: value.startedSeq,
        index,
      })),
      ...[...(current ? [current] : []), ...Object.values(currentByMessage)].map(
        (value, index) => ({
          kind: 'streaming' as const,
          value,
          startedSeq: value.startedSeq,
          index: messages.length + index,
        }),
      ),
      ...contextItems.map((value, index) => ({
        kind: 'context' as const,
        value,
        startedSeq: value.eventSeq,
        index: messages.length + Object.keys(currentByMessage).length + (current ? 1 : 0) + index,
      })),
    ];
    // Keep unsequenced optimistic rows in place while sorting durable turns.
    const sequenced = turns
      .filter((turn) => turn.startedSeq !== undefined)
      .sort((a, b) => a.startedSeq! - b.startedSeq! || a.index - b.index);
    let nextSequenced = 0;
    return turns.map((turn) => (turn.startedSeq === undefined ? turn : sequenced[nextSequenced++]));
  }, [messages, current, currentByMessage, contextItems]);

  const touchStart = useRef<{ x: number; y: number } | null>(null);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }, []);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (!touchStart.current) return;
    const dx = e.changedTouches[0].clientX - touchStart.current.x;
    const dy = e.changedTouches[0].clientY - touchStart.current.y;
    touchStart.current = null;
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
      const target = e.target as HTMLElement;
      if (!target.closest('button, a, select, input, textarea, [role="button"]')) {
        (document.activeElement as HTMLElement)?.blur?.();
      }
    }
  }, []);

  const transcriptRows: ActivityRow<ReactNode>[] = orderedTurns.flatMap(
    (turn): ActivityRow<ReactNode>[] => {
      if (turn.kind === 'context') {
        const item = turn.value;
        return [
          {
            key: `context:${item.deliveryId}:${item.attemptId}`,
            scope: 'context',
            value: (
              <article
                key={`context:${item.deliveryId}:${item.attemptId}`}
                className="msg-turn symposium-context-card"
                style={{ borderLeft: `3px solid ${seatAccentColor(item.recipientSeatId)}` }}
              >
                <strong>
                  {item.receipt === 'received'
                    ? `Received context: ${item.sourceSeatId ?? 'you'} to ${item.recipientSeatId}`
                    : `Dispatch uncertain for ${item.recipientSeatId}`}
                </strong>
                {item.sourceMessageId && (
                  <small>Excerpt from {item.sourceSeatId ?? 'your message'}</small>
                )}
                <p>{item.content}</p>
              </article>
            ),
          },
        ];
      }
      if (turn.kind === 'finished') {
        const msg = turn.value;
        if (msg.role === 'user') {
          const textBlock = msg.blocks.find((b) => b.blockType === 'text');
          return [
            {
              key: turnKey(msg.messageId, msg.symposiumProvenance),
              scope: 'user',
              endsTurn: true,
              value: (
                <>
                  {renderMessageAttribution?.(msg.messageId)}
                  <div data-command-request={msg.messageId} tabIndex={-1}>
                    <UserBubble
                      key={turnKey(msg.messageId, msg.symposiumProvenance)}
                      sourceAnchor={sourceAnchor(msg)}
                      text={textBlock?.content}
                      images={msg.images}
                      contextBlocks={msg.contextBlocks}
                      contextInjections={msg.contextInjections}
                      timestamp={msg.timestamp}
                      readAloud={
                        voice?.ttsAvailable
                          ? {
                              active: speakingBlockId === msg.messageId,
                              onSpeak: (text) => speakBlock(msg.messageId, text),
                              onStop: stopBlock,
                            }
                          : undefined
                      }
                    />
                    {!msg.symposiumProvenance && msg.commandState && (
                      <div className="chat-command-meta chat-command-meta--user" role="status">
                        {msg.steersMessageId && msg.commandState === 'failed'
                          ? 'Correction not accepted'
                          : commandLabels[msg.commandState]}
                      </div>
                    )}
                  </div>
                  {createdItemCards(msg)}
                  {renderMessageOutcome?.(msg.messageId)}
                </>
              ),
            },
          ];
        }
      }
      const streaming = turn.kind === 'streaming';
      const msg = turn.value;
      const blocks: ChatBlock[] =
        turn.kind === 'streaming'
          ? turn.value.blockOrder.flatMap((id) => {
              const block = turn.value.blocks.get(id);
              return block ? [block] : [];
            })
          : turn.value.blocks;
      const ownerKey = `${sessionId ?? 'chat'}:${turnKey(msg.messageId, msg.symposiumProvenance)}`;
      const provenance = msg.symposiumProvenance;
      const attribution =
        !streaming && renderMessageAttribution ? (
          renderMessageAttribution(msg.messageId)
        ) : (
          <SeatAttribution provenance={msg.symposiumProvenance} compact={compactAttribution} />
        );
      const scope = JSON.stringify([
        sessionId ?? null,
        provenance?.seatId,
        provenance?.membershipGeneration,
        provenance?.configRevision,
        provenance && 'accountBinding' in provenance ? provenance.accountBinding : null,
      ]);
      // Filter non-visible text before assigning first/last-row controls so
      // speaker attribution and sharing stay attached to retained content.
      const firstVisibleText = blocks.find(
        (block) => block.blockType === 'text' && block.content?.trim(),
      );
      const rows = blocks
        .filter((block) => block.blockType !== 'text' || block.content?.trim())
        .map((block, index): ActivityRow<ReactNode> => {
          const progress = progressFor(msg.messageId, msg.symposiumProvenance, block.toolId);
          const keepVisible =
            Boolean(progress) ||
            Boolean(telosWorkerReceipt(block, sessionId)) ||
            (!completedWebsiteRead(block) &&
              ['RequestWebAccess', 'mcp__mitzo-web-access__RequestWebAccess'].includes(
                block.toolName ?? '',
              ));
          const bid = block.blockId || `text-${index}`;
          let content: ReactNode;
          if (block.blockType === 'thinking' || block.blockType === 'redacted_thinking') {
            content = (
              <ThinkingBlock
                block={block}
                streaming={streaming}
                defaultExpanded={false}
                autoCollapse={false}
              />
            );
          } else if (block.blockType === 'tool_use') {
            content = progress ? (
              <ProgressWidget items={progress.items} />
            ) : (
              <ToolPill block={block} sessionId={sessionId} showSetupCard={keepVisible} />
            );
          } else {
            content = (
              <TextBubble
                sourceAnchor={
                  !streaming &&
                  turn.kind === 'finished' &&
                  block === firstVisibleText &&
                  sourceAnchor(turn.value)
                }
                content={block.content ?? ''}
                streaming={streaming}
                timestamp={turn.kind === 'finished' ? turn.value.timestamp : undefined}
                artifactSessionId={
                  !streaming && messageSessionId ? messageSessionId(msg.messageId) : sessionId
                }
                readAloud={
                  !streaming && voice?.ttsAvailable
                    ? {
                        active: speakingBlockId === bid,
                        onSpeak: (text) => speakBlock(bid, text),
                        onStop: stopBlock,
                      }
                    : undefined
                }
              />
            );
          }
          return {
            key: `${ownerKey}:${bid}`,
            scope,
            attribution,
            block,
            streaming,
            keepVisible,
            value: (
              <div className={`msg-turn${streaming ? ' msg-turn--streaming' : ''}`}>
                {index === 0 && (keepVisible || block.blockType === 'text') && attribution}
                {block === firstVisibleText && replyLabel(msg)}
                {content}
              </div>
            ),
          };
        });
      if (!streaming && turn.kind === 'finished') {
        const last = rows.at(-1);
        if (last)
          last.value = (
            <>
              {last.value}
              {createdItemCards(turn.value)}
              {renderMessageOutcome?.(msg.messageId)}
            </>
          );
      }
      if (
        !streaming &&
        'role' in msg &&
        onShareMessage &&
        (!canShareMessage || canShareMessage(msg))
      ) {
        const shareButton = (
          <button
            type="button"
            className="symposium-share-action"
            onClick={(event) => {
              const disclosure = event.currentTarget.closest('details');
              if (disclosure) {
                disclosure.open = false;
                disclosure.querySelector('summary')?.focus();
              }
              onShareMessage(msg.messageId, msg.symposiumProvenance);
            }}
          >
            Share excerpt
          </button>
        );
        const share = shareInActions ? (
          <details
            className="conversation-message-actions"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.currentTarget.open = false;
                event.currentTarget.querySelector('summary')?.focus();
              }
            }}
          >
            <summary aria-label="Message actions">
              <UiIcon name="more" />
            </summary>
            {shareButton}
          </details>
        ) : (
          shareButton
        );
        const last = rows.at(-1);
        if (last)
          last.value = (
            <>
              {last.value}
              {share}
            </>
          );
        else
          rows.push({
            key: `${ownerKey}:share`,
            scope,
            activityControl: true,
            value: (
              <div className="msg-turn">
                <SeatAttribution
                  provenance={msg.symposiumProvenance}
                  compact={compactAttribution}
                />
                {share}
              </div>
            ),
          });
      }
      return rows;
    },
  );

  // The lifecycle carries the last app message identity. Unknown positions stay
  // explicit at the end rather than being attributed to an invented message.
  const rowsWithCompactions = [...transcriptRows];
  for (const record of [...compactions].reverse()) {
    let position = -1;
    if (record.afterMessageId)
      for (let index = 0; index < rowsWithCompactions.length; index++) {
        const key = rowsWithCompactions[index].key;
        if (key === record.afterMessageId || key.includes(`:${record.afterMessageId}:`))
          position = index;
      }
    const marker = {
      key: `compaction:${record.id}`,
      scope: 'compaction',
      value: <CompactionMarker record={record} positionKnown={position >= 0} />,
    };
    rowsWithCompactions.splice(position < 0 ? rowsWithCompactions.length : position + 1, 0, marker);
  }

  return (
    <>
      <div
        className="chat-messages"
        ref={scrollRef}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        {messages.length === 0 &&
          !current &&
          Object.keys(currentByMessage).length === 0 &&
          contextItems.length === 0 &&
          !running && <p className="chat-empty">Send a message to start</p>}

        {groupActivityRows(rowsWithCompactions).map((item) =>
          item.type === 'activity' ? (
            <AgentActivity
              key={item.key}
              rows={item.rows}
              sessionId={sessionId}
              replied={item.replied}
            />
          ) : (
            <Fragment key={item.row.key}>{item.row.value}</Fragment>
          ),
        )}
        {afterMessages}
      </div>

      {permission && (
        <PermissionBanner
          key={permission.permId}
          permId={permission.permId}
          sessionId={sessionId ?? permission.sessionId}
          reviewKind={permission.reviewKind}
          recoveryOnly={permission.recoveryOnly}
          questions={permission.questions}
          expiresAt={permission.expiresAt}
          toolName={permission.toolName}
          toolInput={permission.toolInput}
          title={permission.title}
          description={permission.description}
          displayName={permission.displayName}
          tier={permission.tier}
          approvalScope={permission.approvalScope}
          allowSessionGrant={permission.allowSessionGrant}
          sessionGrantDescription={permission.sessionGrantDescription}
          responseError={permission.responseError}
          onRespond={onPermissionRespond}
          onExpire={onPermissionExpire}
        />
      )}
    </>
  );
}
