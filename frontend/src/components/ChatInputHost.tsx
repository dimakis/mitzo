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
import {
  SharedConversationComposerContext,
  type SharedConversationComposerRouting,
} from '../lib/shared-conversation-composer';
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
    let snapshot: { content: ReactNode; routing: SharedConversationComposerRouting } = {
      content: null,
      routing: null,
    };
    let contentSessionId: string | undefined;
    let target: HTMLElement | null = null;
    let focus: HTMLElement | null = null;
    const listeners = new Set<() => void>();
    const update = (
      nextTarget: HTMLElement,
      nextContent: ReactNode,
      routing: SharedConversationComposerRouting,
    ) => {
      if (
        target !== nextTarget ||
        (snapshot.content === nextContent && snapshot.routing === routing)
      )
        return;
      snapshot = { content: nextContent, routing };
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
      getSnapshot: () => snapshot,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      update,
      updateRouting(nextTarget: HTMLElement, routing: SharedConversationComposerRouting) {
        update(nextTarget, snapshot.content, routing);
      },
      hasRetained: (id?: string) => !!snapshot.content && contentSessionId === id,
      attachRetained(nextTarget: HTMLElement, id?: string) {
        if (!snapshot.content || contentSessionId !== id) return;
        return attachTarget(nextTarget);
      },
      attach(
        nextTarget: HTMLElement,
        nextContent: ReactNode,
        routing: SharedConversationComposerRouting,
        id?: string,
      ) {
        const detach = attachTarget(nextTarget);
        contentSessionId = id;
        update(nextTarget, nextContent, routing);
        return detach;
      },
    };
  }, []);
  const context = useMemo(
    () => ({
      ...store,
      sessionId,
      attach: (
        target: HTMLElement,
        content: ReactNode,
        routing: SharedConversationComposerRouting,
      ) => store.attach(target, content, routing, sessionId),
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
  const shared = useContext(SharedConversationComposerContext);
  const slot = useRef<HTMLDivElement>(null);
  const retained = host && host.sessionId === sessionId && host.hasRetained() ? host : null;
  useLayoutEffect(() => {
    if (retained && slot.current) return retained.attachRetained(slot.current);
  }, [retained]);
  useLayoutEffect(() => {
    if (retained && slot.current)
      retained.updateRouting(
        slot.current,
        shared ?? {
          sourceConversationId: sessionId ?? '',
          props: { sendDisabledReason: 'Checking conversation status…' },
        },
      );
  });
  return retained ? <div className="chat-input-mount" ref={slot} /> : children;
}
function InputPortal({
  store,
}: {
  store: {
    container: HTMLElement;
    getSnapshot(): { content: ReactNode; routing: SharedConversationComposerRouting };
    subscribe(listener: () => void): () => void;
  };
}) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return createPortal(
    <SharedConversationComposerContext.Provider value={snapshot.routing}>
      {snapshot.content}
    </SharedConversationComposerContext.Provider>,
    store.container,
  );
}
