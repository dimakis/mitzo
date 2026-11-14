import { useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChatInputMountContext } from '../lib/chat-input-mount';
import './ChatInputHost.css';

/** One ordinary input across phone/desktop page owners. Moving its DOM target
 * preserves the actual textarea, rich edits and pending delivery callbacks. */
export function ChatInputHost({
  children,
  sessionId,
}: {
  children: ReactNode;
  sessionId?: string;
}) {
  const store = useMemo(() => {
    const container = document.createElement('div');
    container.className = 'chat-input-host';
    let content: ReactNode = null;
    let target: HTMLElement | null = null;
    let focus: HTMLElement | null = null;
    const listeners = new Set<() => void>();
    const update = (nextTarget: HTMLElement, nextContent: ReactNode) => {
      if (target !== nextTarget || content === nextContent) return;
      content = nextContent;
      listeners.forEach((listener) => listener());
    };
    return {
      container,
      getSnapshot: () => content,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      update,
      attach(nextTarget: HTMLElement, nextContent: ReactNode) {
        target = nextTarget;
        nextTarget.append(container);
        update(nextTarget, nextContent);
        if (focus && container.contains(focus)) focus.focus({ preventScroll: true });
        focus = null;
        return () => {
          if (target !== nextTarget) return;
          focus =
            document.activeElement instanceof HTMLElement &&
            container.contains(document.activeElement)
              ? document.activeElement
              : null;
          target = null;
        };
      },
    };
  }, []);
  const context = useMemo(() => ({ ...store, sessionId }), [store, sessionId]);
  return (
    <ChatInputMountContext.Provider value={context}>
      {children}
      <InputPortal store={store} />
    </ChatInputMountContext.Provider>
  );
}
function InputPortal({
  store,
}: {
  store: {
    container: HTMLElement;
    getSnapshot(): ReactNode;
    subscribe(listener: () => void): () => void;
  };
}) {
  const content = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return createPortal(content, store.container);
}
