import { useEffect, useMemo, useRef } from 'react';
import { UserBubble, TextBubble } from './MessageBubble';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolPill } from './ToolPill';
import { ToolGroup } from './ToolGroup';
import { PermissionBanner } from './PermissionBanner';
import { groupBlocks } from '../lib/groupMessages';
import { SCROLL_NEAR_BOTTOM_PX } from '../lib/constants';
import type {
  FinishedMessage,
  FinishedBlock,
  StreamingMessage,
  PermissionRequest,
} from '../types/chat';

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
}

export function ChatArea({
  messages,
  current,
  running,
  permission,
  onPermissionRespond,
  scrollRef: externalScrollRef,
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

  // Group blocks per finished assistant turn for tool collapsing.
  const groupedMessages = useMemo(
    () =>
      messages.map((msg) => ({
        msg,
        grouped: msg.role === 'assistant' ? groupBlocks(msg.blocks) : null,
      })),
    [messages],
  );

  return (
    <>
      <div
        className="chat-messages"
        ref={scrollRef}
        onTouchStart={() => (document.activeElement as HTMLElement)?.blur?.()}
      >
        {messages.length === 0 && !current && !running && (
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
                  return <ToolPill key={block.blockId} block={block} />;
                }
                return (
                  <TextBubble key={block.blockId || `text-${i}`} content={block.content ?? ''} />
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
