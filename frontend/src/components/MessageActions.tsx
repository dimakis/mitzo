import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { MessageReplyContext } from '@mitzo/protocol';
import type { ReadAloudProps } from './MessageBubble';
import { MotionPresence } from './MotionPresence';
import { UiIcon } from './UiIcon';
import { useCopyFeedback } from '../hooks/useCopyFeedback';
import { formatFullMessageDate } from '../lib/formatTime';
import { MessageActionsContext } from '../lib/message-actions-context';
import './MessageActions.css';
const SWIPE_MAX_MS = 500;
const SWIPE_DISTANCE = 64;
const INTERACTIVE = 'button,a,input,textarea,select,pre,code,iframe,.html-preview-card';
const hasSelection = () => window.getSelection()?.isCollapsed === false;
/** Native selection owns touch holds; explicit actions share one exact message. */
export function MessageActions({
  message,
  onReply,
  readAloud,
  children,
}: {
  message: MessageReplyContext;
  onReply?: (message: MessageReplyContext) => void;
  readAloud?: ReadAloudProps;
  children: ReactNode;
}) {
  const owner = useRef<HTMLDivElement>(null),
    panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const pointerType = useRef('');
  const press = useRef<{
    x: number;
    y: number;
    startedAt: number;
  } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const { copy, copied } = useCopyFeedback();
  const clearPress = () => {
    press.current = null;
  };
  const close = (restore = true) => {
    setMenu(null);
    if (restore) (trigger.current ?? owner.current)?.focus({ preventScroll: true });
  };
  const open = (x: number, y: number) => {
    if (onReply) setMenu({ x, y });
  };
  useEffect(() => {
    if (!onReply) {
      clearPress();
      setMenu(null);
    }
  }, [onReply]);
  useEffect(() => {
    if (!onReply) return;
    const selectionChanged = () => {
      if (!hasSelection()) return;
      press.current = null;
      setMenu(null);
    };
    document.addEventListener('selectionchange', selectionChanged);
    return () => document.removeEventListener('selectionchange', selectionChanged);
  }, [onReply]);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node)) setMenu(null);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [menu]);
  useLayoutEffect(() => {
    if (!menu || !panel.current) return;
    const el = panel.current,
      rect = el.getBoundingClientRect();
    el.style.left = Math.max(8, Math.min(menu.x, innerWidth - rect.width - 8)) + 'px';
    el.style.top = Math.max(8, Math.min(menu.y, innerHeight - rect.height - 8)) + 'px';
    el.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }, [menu]);
  const interactive = (target: EventTarget) =>
    target instanceof Element && !!target.closest(INTERACTIVE);
  return (
    <div
      ref={owner}
      className={`message-actions-target${message.role === 'user' ? ' message-actions-target--user' : ''}`}
      tabIndex={onReply ? 0 : undefined}
      aria-label={`Message from ${message.role === 'user' ? 'you' : 'Mitzo'}`}
      onContextMenu={(event) => {
        // WebKit's contextmenu can precede selectionchange and lack pointerType.
        const type = (event.nativeEvent as PointerEvent).pointerType || pointerType.current;
        if (
          !onReply ||
          interactive(event.target) ||
          hasSelection() ||
          ['touch', 'pen'].includes(type)
        )
          return;
        event.preventDefault();
        clearPress();
        trigger.current = null;
        open(event.clientX, event.clientY);
      }}
      onKeyDown={(event) => {
        if (!onReply || event.target !== event.currentTarget) return;
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          if (hasSelection()) return;
          event.preventDefault();
          trigger.current = null;
          const rect = event.currentTarget.getBoundingClientRect();
          open(rect.left, rect.top);
        }
      }}
      onPointerDown={(event) => {
        pointerType.current = event.pointerType;
        clearPress();
        if (
          !onReply ||
          event.button !== 0 ||
          !['touch', 'pen'].includes(event.pointerType) ||
          interactive(event.target) ||
          hasSelection()
        )
          return;
        press.current = {
          x: event.clientX,
          y: event.clientY,
          startedAt: performance.now(),
        };
      }}
      onPointerCancel={clearPress}
      onPointerUp={(event) => {
        const current = press.current;
        clearPress();
        if (
          !onReply ||
          !current ||
          hasSelection() ||
          performance.now() - current.startedAt >= SWIPE_MAX_MS
        )
          return;
        const dx = event.clientX - current.x,
          dy = Math.abs(event.clientY - current.y);
        if (dx > SWIPE_DISTANCE && dy < 32) {
          event.preventDefault();
          onReply(message);
        }
      }}
    >
      <MessageActionsContext
        value={
          onReply ? (
            <button
              type="button"
              className="message-actions-trigger"
              aria-label="Message actions"
              aria-haspopup="menu"
              aria-expanded={!!menu}
              onClick={(event) => {
                event.stopPropagation();
                trigger.current = event.currentTarget;
                const rect = event.currentTarget.getBoundingClientRect();
                open(rect.left, rect.bottom);
              }}
            >
              <UiIcon name="more" size={16} />
            </button>
          ) : null
        }
      >
        {children}
      </MessageActionsContext>
      <span className="sr-only" role={onReply ? 'status' : undefined}>
        {onReply && copied ? 'Message copied.' : ''}
      </span>
      {createPortal(
        <MotionPresence open={!!menu && !!onReply} kind="popover">
          <div
            ref={panel}
            className="message-actions-menu"
            role="menu"
            aria-label="Message actions"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                close();
              } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                const items = Array.from(
                    panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ??
                      [],
                  ),
                  at = items.indexOf(document.activeElement as HTMLButtonElement);
                items[
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? items.length - 1
                      : (at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
                ]?.focus();
              } else if (event.key === 'Tab') close(false);
            }}
          >
            {message.timestamp !== undefined && (
              <time
                className="message-actions-date"
                dateTime={new Date(message.timestamp).toISOString()}
              >
                {formatFullMessageDate(message.timestamp)}
              </time>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                close(false);
                onReply?.(message);
              }}
            >
              <UiIcon name="back" size={16} />
              Reply
            </button>
            <button type="button" role="menuitem" onClick={() => void copy(message.text)}>
              <UiIcon name={copied ? 'check' : 'copy'} size={16} />
              {copied ? 'Copied' : 'Copy text'}
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!readAloud}
              onClick={() => {
                if (readAloud) {
                  if (readAloud.active) readAloud.onStop();
                  else readAloud.onSpeak(message.text);
                }
                close();
              }}
            >
              <UiIcon name="volume" size={16} />
              {readAloud?.active ? 'Stop reading' : 'Read aloud'}
            </button>
          </div>
        </MotionPresence>,
        document.body,
      )}
    </div>
  );
}
