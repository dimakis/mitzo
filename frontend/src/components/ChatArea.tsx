import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { UserBubble, TextBubble } from './MessageBubble';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolPill } from './ToolPill';
import { ToolGroup } from './ToolGroup';
import { PermissionBanner } from './PermissionBanner';
import { ProgressWidget } from './ProgressWidget';
import { groupBlocks } from '../lib/groupMessages';
import { SCROLL_NEAR_BOTTOM_PX } from '../lib/constants';
import type {
  FinishedMessage,
  FinishedBlock,
  StreamingMessage,
  PermissionRequest,
} from '../types/chat';
import type { ProgressBlock } from '@mitzo/protocol';
import type { SymposiumProvenance } from '@mitzo/protocol';
import { progressToolLookupKey } from '@mitzo/client';
import type { UseVoiceReturn } from '../hooks/useVoice';

export type ChatAreaVoice = Pick<
  UseVoiceReturn,
  'ttsAvailable' | 'speak' | 'stopSpeaking' | 'speaking'
>;

export interface ChatAreaProps {
  sessionId?: string;
  messages: FinishedMessage[];
  current: StreamingMessage | null;
  currentByMessage?: Record<string, StreamingMessage>;
  running: boolean;
  permission: PermissionRequest | null;
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

function SeatAttribution({ provenance }: { provenance?: SymposiumProvenance }) {
  if (!provenance) return null;
  if (!('version' in provenance) || provenance.version !== 2) {
    return (
      <div className="chat-seat-attribution">
        {provenance.seatId.charAt(0).toUpperCase() + provenance.seatId.slice(1)} seat · account and
        model unknown
      </div>
    );
  }
  return (
    <div className="chat-seat-attribution" aria-label={`Seat ${provenance.seatLabel}`}>
      <strong>{provenance.seatLabel}</strong>
      <span>{provenance.seatRole}</span>
      <span>{provenance.accountBinding.accountLabel}</span>
      <span>{provenance.accountBinding.model}</span>
      <span>{provenance.reasoningEffort ?? 'effort unspecified'}</span>
    </div>
  );
}

function turnKey(messageId: string, provenance?: SymposiumProvenance): string {
  return provenance
    ? `symposium:${JSON.stringify([provenance.seatId, provenance.membershipGeneration ?? null, messageId])}`
    : messageId;
}

export function ChatArea({
  sessionId,
  messages,
  current,
  currentByMessage = {},
  running,
  permission,
  onPermissionRespond,
  scrollRef: externalScrollRef,
  progressByToolId,
  voice,
}: ChatAreaProps) {
  const internalScrollRef = useRef<HTMLDivElement>(null);
  const scrollRef = externalScrollRef ?? internalScrollRef;
  const prevMessageCount = useRef(0);
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
    prevMessageCount.current = messages.length;
    if (wasEmpty && messages.length > 0) {
      shouldFollowStreamRef.current = true;
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
      });
    }
  }, [messages, scrollRef]);

  // Auto-scroll during streaming only while the reader has chosen to follow it.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && shouldFollowStreamRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, current, currentByMessage, scrollRef]);

  const progressFor = useCallback(
    (messageId: string, provenance: SymposiumProvenance | undefined, toolId?: string) =>
      toolId ? progressByToolId?.[progressToolLookupKey(messageId, toolId, provenance)] : undefined,
    [progressByToolId],
  );
  const progressToolIdsFor = useCallback(
    (
      messageId: string,
      provenance: SymposiumProvenance | undefined,
      blocks: Array<{ toolId?: string }>,
    ) =>
      new Set(
        blocks
          .filter((block) => progressFor(messageId, provenance, block.toolId))
          .map((block) => block.toolId!),
      ),
    [progressFor],
  );

  // Group blocks per finished assistant turn for tool collapsing.
  const groupedMessages = useMemo(
    () =>
      messages.map((msg) => ({
        msg,
        grouped:
          msg.role === 'assistant'
            ? groupBlocks(
                msg.blocks,
                progressToolIdsFor(msg.messageId, msg.symposiumProvenance, msg.blocks),
              )
            : null,
      })),
    [messages, progressToolIdsFor],
  );

  const orderedTurns = useMemo(() => {
    const turns = [
      ...groupedMessages.map((value, index) => ({
        kind: 'finished' as const,
        value,
        startedSeq: value.msg.startedSeq,
        index,
      })),
      ...[...(current ? [current] : []), ...Object.values(currentByMessage)].map(
        (value, index) => ({
          kind: 'streaming' as const,
          value,
          startedSeq: value.startedSeq,
          index: groupedMessages.length + index,
        }),
      ),
    ];
    return turns.sort((a, b) =>
      a.startedSeq !== undefined && b.startedSeq !== undefined
        ? a.startedSeq - b.startedSeq
        : a.index - b.index,
    );
  }, [groupedMessages, current, currentByMessage]);

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
          !running && <p className="chat-empty">Send a message to start</p>}

        {orderedTurns.map((turn) => {
          if (turn.kind === 'streaming') {
            const stream = turn.value;
            return (
              <div
                key={turnKey(stream.messageId, stream.symposiumProvenance)}
                className="msg-turn msg-turn--streaming"
              >
                <SeatAttribution provenance={stream.symposiumProvenance} />
                {groupBlocks(
                  stream.blockOrder.flatMap((blockId) => {
                    const block = stream.blocks.get(blockId);
                    return block ? [block] : [];
                  }),
                  progressToolIdsFor(
                    stream.messageId,
                    stream.symposiumProvenance,
                    stream.blockOrder.flatMap((blockId) => {
                      const block = stream.blocks.get(blockId);
                      return block ? [block] : [];
                    }),
                  ),
                ).map((item) => {
                  if (item.type === 'tool-group')
                    return <ToolGroup key={item.key} tools={item.tools} sessionId={sessionId} />;
                  const block = item.block;
                  if (block.blockType === 'thinking' || block.blockType === 'redacted_thinking')
                    return <ThinkingBlock key={block.blockId} block={block} streaming />;
                  if (block.blockType === 'tool_use') {
                    const progress = progressFor(
                      stream.messageId,
                      stream.symposiumProvenance,
                      block.toolId,
                    );
                    return progress ? (
                      <ProgressWidget key={block.blockId} items={progress.items} />
                    ) : (
                      <ToolPill key={block.blockId} block={block} sessionId={sessionId} />
                    );
                  }
                  return (
                    <TextBubble
                      key={block.blockId}
                      content={block.content ?? ''}
                      streaming
                      artifactSessionId={sessionId}
                    />
                  );
                })}
              </div>
            );
          }
          const { msg, grouped } = turn.value;
          if (msg.role === 'user') {
            const textBlock = msg.blocks.find((b) => b.blockType === 'text');
            return (
              <UserBubble
                key={turnKey(msg.messageId, msg.symposiumProvenance)}
                text={textBlock?.content}
                images={msg.images}
                contextBlocks={msg.contextBlocks}
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
            );
          }

          // Assistant turn — render grouped blocks
          return (
            <div key={turnKey(msg.messageId, msg.symposiumProvenance)} className="msg-turn">
              <SeatAttribution provenance={msg.symposiumProvenance} />
              {(grouped ?? []).map((item, i) => {
                if (item.type === 'tool-group') {
                  return <ToolGroup key={item.key} tools={item.tools} sessionId={sessionId} />;
                }
                const block: FinishedBlock = item.block;
                if (block.blockType === 'thinking' || block.blockType === 'redacted_thinking') {
                  return <ThinkingBlock key={block.blockId} block={block} />;
                }
                if (block.blockType === 'tool_use') {
                  const progress = progressFor(
                    msg.messageId,
                    msg.symposiumProvenance,
                    block.toolId,
                  );
                  if (progress) {
                    return <ProgressWidget key={block.blockId} items={progress.items} />;
                  }
                  return <ToolPill key={block.blockId} block={block} sessionId={sessionId} />;
                }
                const bid = block.blockId || `text-${i}`;
                return (
                  <TextBubble
                    key={bid}
                    content={block.content ?? ''}
                    timestamp={msg.timestamp}
                    artifactSessionId={sessionId}
                    readAloud={
                      voice?.ttsAvailable
                        ? {
                            active: speakingBlockId === bid,
                            onSpeak: (text) => speakBlock(bid, text),
                            onStop: stopBlock,
                          }
                        : undefined
                    }
                  />
                );
              })}
            </div>
          );
        })}
      </div>

      {permission && (
        <PermissionBanner
          key={permission.permId}
          permId={permission.permId}
          questions={permission.questions}
          expiresAt={permission.expiresAt}
          toolName={permission.toolName}
          toolInput={permission.toolInput}
          title={permission.title}
          description={permission.description}
          displayName={permission.displayName}
          tier={permission.tier}
          approvalScope={permission.approvalScope}
          responseError={permission.responseError}
          onRespond={onPermissionRespond}
        />
      )}
    </>
  );
}
