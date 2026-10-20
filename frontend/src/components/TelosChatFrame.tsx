import { useId, useRef, useState, type ReactNode } from 'react';
import { MotionPresence } from './MotionPresence';
import { UiIcon } from './UiIcon';
import { TelosChatTreeContext } from '../lib/telos-chat-tree-context';
import './TelosChat.css';

/** Layout slots deliberately retain the ordinary header, transcript and composer.
 * The shared chat owners adopt this frame after their integration dependencies. */
export function TelosChatFrame({
  className = '',
  linked = true,
  conversationId,
  itemTitle,
  chatCount,
  onItem,
  onChats,
  header,
  tree,
  children,
}: {
  className?: string;
  linked?: boolean;
  conversationId: string;
  itemTitle: string;
  chatCount: number;
  onItem(): void;
  onChats(): void;
  header: ReactNode;
  tree: ReactNode;
  children: ReactNode;
}) {
  const [disclosure, setDisclosure] = useState({ conversationId, open: false });
  // A route may reuse the ordinary screen for another conversation. Reset only
  // this disclosure; keying the whole frame would remount the ordinary composer.
  if (disclosure.conversationId !== conversationId) setDisclosure({ conversationId, open: false });
  const open = disclosure.conversationId === conversationId && disclosure.open;
  const setOpen = (value: boolean) => setDisclosure({ conversationId, open: value });
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  function close() {
    setOpen(false);
    trigger.current?.focus();
  }
  return (
    <TelosChatTreeContext.Provider
      value={() => {
        setOpen(true);
        trigger.current?.focus();
      }}
    >
      <section className={`telos-chat-frame ${className}${linked ? '' : ' telos-chat-unlinked'}`}>
        {header}
        {linked && (
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
            <button
              type="button"
              aria-label={`Chats for this item: ${chatCount}`}
              onClick={onChats}
            >
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
        )}
        <div className="telos-chat-body" data-tree-open={open}>
          <div className="telos-chat-transcript">{children}</div>
          <MotionPresence
            open={linked && open}
            kind="disclosure"
            className="telos-chat-tree-presence"
          >
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
    </TelosChatTreeContext.Provider>
  );
}
