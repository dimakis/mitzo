import {
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
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
    let contentSessionId: string | undefined;
    let target: HTMLElement | null = null;
    let focus: HTMLElement | null = null;
    const listeners = new Set<() => void>();
    const update = (nextTarget: HTMLElement, nextContent: ReactNode) => {
      if (target !== nextTarget || content === nextContent) return;
      content = nextContent;
      listeners.forEach((listener) => listener());
    };
    const attachTarget = (nextTarget: HTMLElement) => {
      target = nextTarget;
      nextTarget.append(container);
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
      hasRetained: (id?: string) => !!content && contentSessionId === id,
      attachRetained(nextTarget: HTMLElement, id?: string) {
        if (!content || contentSessionId !== id) return;
        return attachTarget(nextTarget);
      },
      attach(nextTarget: HTMLElement, nextContent: ReactNode, id?: string) {
        const detach = attachTarget(nextTarget);
        contentSessionId = id;
        update(nextTarget, nextContent);
        return detach;
      },
    };
  }, []);
  const context = useMemo(
    () => ({
      ...store,
      sessionId,
      attach: (target: HTMLElement, content: ReactNode) => store.attach(target, content, sessionId),
      hasRetained: () => store.hasRetained(sessionId),
      attachRetained: (target: HTMLElement) => store.attachRetained(target, sessionId),
    }),
    [store, sessionId],
  );
  return (
    <ChatInputMountContext.Provider value={context}>
      {children}
      <InputPortal store={store} />
    </ChatInputMountContext.Provider>
  );
}

/** Reattach the already qualified owner while a new responsive page reads its
 * status. A different conversation must wait for its own qualified composer. */
export function RetainedChatInputSlot({
  sessionId,
  children,
}: {
  sessionId?: string;
  children: ReactNode;
}) {
  const host = useContext(ChatInputMountContext);
  const slot = useRef<HTMLDivElement>(null);
  const retained = host && host.sessionId === sessionId && host.hasRetained() ? host : null;
  useLayoutEffect(() => {
    if (retained && slot.current) return retained.attachRetained(slot.current);
  }, [retained]);
  return retained ? <div className="chat-input-mount" ref={slot} /> : children;
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
