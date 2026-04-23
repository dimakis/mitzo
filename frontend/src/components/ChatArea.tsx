import { useCallback, useEffect, useMemo, useRef } from 'react';
import { UserBubble, TextBubble } from './MessageBubble';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolPill } from './ToolPill';
import { ToolGroup } from './ToolGroup';
import { ContextBlock } from './ContextBlock';
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

export interface ChatAreaProps {
  messages: FinishedMessage[];
  current: StreamingMessage | null;
  running: boolean;
  permission: PermissionRequest | null;
  onPermissionRespond: (
    permId: string,
    decision: 'once' | 'always' | 'deny',
    toolName: string,
  ) => void;
  /** External ref for scroll container — caller can use for forceScrollToBottom */
  scrollRef?: React.RefObject<HTMLDivElement | null>;
  /** Boot context for sessions started from inbox/todo items */
  sessionContext?: string | null;
  /** Progress blocks indexed by toolId for rendering ProgressWidget on TodoWrite blocks */
  progressByToolId?: Record<string, ProgressBlock>;
}

export function ChatArea({
  messages,
  current,
  running,
  permission,
  onPermissionRespond,
  scrollRef: externalScrollRef,
  sessionContext,
  progressByToolId,
}: ChatAreaProps) {
  const internalScrollRef = useRef<HTMLDivElement>(null);
  const scrollRef = externalScrollRef ?? internalScrollRef;
  const prevMessageCount = useRef(0);

  // Scroll to bottom on session restore (messages jump from 0 to N)
  useEffect(() => {
    const wasEmpty = prevMessageCount.current === 0;
    prevMessageCount.current = messages.length;
    if (wasEmpty && messages.length > 0) {
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
      });
    }
  }, [messages, scrollRef]);

  // Auto-scroll during streaming: follow new content if user is near the bottom
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distFromBottom <= SCROLL_NEAR_BOTTOM_PX) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, current, scrollRef]);

  // Set of toolIds that have progress data (excluded from tool grouping).
  const progressToolIds = useMemo(
    () => new Set(Object.keys(progressByToolId ?? {})),
    [progressByToolId],
  );

  // Group blocks per finished assistant turn for tool collapsing.
  const groupedMessages = useMemo(
    () =>
      messages.map((msg) => ({
        msg,
        grouped: msg.role === 'assistant' ? groupBlocks(msg.blocks, progressToolIds) : null,
      })),
    [messages, progressToolIds],
  );

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
        {sessionContext && <ContextBlock content={sessionContext} />}

        {messages.length === 0 && !current && !running && !sessionContext && (
          <p className="chat-empty">Send a message to start</p>
        )}

        {/* Finished turns */}
        {groupedMessages.map(({ msg, grouped }) => {
          if (msg.role === 'user') {
            const textBlock = msg.blocks.find((b) => b.blockType === 'text');
            return (
              <UserBubble
                key={msg.messageId}
                text={textBlock?.content}
                images={msg.images}
                contextBlocks={msg.contextBlocks}
                timestamp={msg.timestamp}
              />
            );
          }

          // Assistant turn — render grouped blocks
          return (
            <div key={msg.messageId} className="msg-turn">
              {(grouped ?? []).map((item, i) => {
                if (item.type === 'tool-group') {
                  return <ToolGroup key={item.key} tools={item.tools} />;
                }
                const block: FinishedBlock = item.block;
                if (block.blockType === 'thinking' || block.blockType === 'redacted_thinking') {
                  return <ThinkingBlock key={block.blockId} block={block} />;
                }
                if (block.blockType === 'tool_use') {
                  const progress = block.toolId ? progressByToolId?.[block.toolId] : undefined;
                  if (progress) {
                    return <ProgressWidget key={block.blockId} items={progress.items} />;
                  }
                  return <ToolPill key={block.blockId} block={block} />;
                }
                return (
                  <TextBubble
                    key={block.blockId || `text-${i}`}
                    content={block.content ?? ''}
                    timestamp={msg.timestamp}
                  />
                );
              })}
            </div>
          );
        })}

        {/* In-flight streaming turn — rendered inline, no grouping */}
        {current && (
          <div className="msg-turn msg-turn--streaming">
            {current.blockOrder.map((blockId) => {
              const block = current.blocks.get(blockId)!;
              if (block.blockType === 'thinking' || block.blockType === 'redacted_thinking') {
                return <ThinkingBlock key={block.blockId} block={block} streaming />;
              }
              if (block.blockType === 'tool_use') {
                const progress = block.toolId ? progressByToolId?.[block.toolId] : undefined;
                if (progress) {
                  return <ProgressWidget key={block.blockId} items={progress.items} />;
                }
                return <ToolPill key={block.blockId} block={block} />;
              }
              return <TextBubble key={block.blockId} content={block.content ?? ''} streaming />;
            })}
          </div>
        )}
      </div>

      {permission && (
        <PermissionBanner
          permId={permission.permId}
          toolName={permission.toolName}
          toolInput={permission.toolInput}
          title={permission.title}
          description={permission.description}
          displayName={permission.displayName}
          tier={permission.tier}
          onRespond={onPermissionRespond}
        />
      )}
    </>
  );
}
