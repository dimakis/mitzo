import { useId, useRef, useState, type ReactNode } from 'react';
import { MotionPresence } from './MotionPresence';
import { UiIcon } from './UiIcon';
import './TelosChat.css';

/** Layout slots deliberately retain the ordinary header, transcript and composer.
 * The shared chat owners adopt this frame after their integration dependencies. */
export function TelosChatFrame({
  itemTitle,
  chatCount,
  onItem,
  onChats,
  header,
  tree,
  children,
}: {
  itemTitle: string;
  chatCount: number;
  onItem(): void;
  onChats(): void;
  header: ReactNode;
  tree: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  function close() {
    setOpen(false);
    trigger.current?.focus();
  }
  return (
    <section className="telos-chat-frame">
      {header}
      <div className="telos-chat-context-row">
        <button
          type="button"
          className="telos-chat-item"
          aria-label={`View item: ${itemTitle}`}
          onClick={onItem}
        >
          <UiIcon name="work" size={16} />
          <span>{itemTitle}</span>
          <UiIcon name="arrowUpRight" size={16} />
        </button>
        <button type="button" aria-label={`Chats for this item: ${chatCount}`} onClick={onChats}>
          <UiIcon name="chats" size={16} />
          <span className="telos-chat-count-label">Chats</span>
          {chatCount}
        </button>
        <button
          type="button"
          ref={trigger}
          aria-label="Toggle work tree"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen(!open)}
        >
          <UiIcon name="work" size={16} />
          Work
        </button>
      </div>
      <div className="telos-chat-body" data-tree-open={open}>
        <div className="telos-chat-transcript">{children}</div>
        <MotionPresence open={open} kind="disclosure" className="telos-chat-tree-presence">
          <section
            id={panelId}
            className="telos-chat-tree"
            role="region"
            aria-label="Work tree"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                close();
              }
            }}
          >
            <div className="telos-chat-actions">
              <h2>Work tree</h2>
              <button
                type="button"
                className="telos-chat-tree-close"
                onClick={close}
                aria-label="Close work tree"
              >
                <UiIcon name="close" size={20} />
              </button>
            </div>
            {tree}
          </section>
        </MotionPresence>
      </div>
    </section>
  );
}
