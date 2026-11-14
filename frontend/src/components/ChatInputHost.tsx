import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
  type ContextType,
} from 'react';
import { createPortal } from 'react-dom';
import { ChatInputMountContext } from '../lib/chat-input-mount';
import {
  ActiveContext,
  SinkContext,
  ViewContext,
  useComposerStatusSink,
  type ComposerStatusSink,
  type ComposerStatusView,
} from '../lib/composer-status-context';
import {
  SharedConversationComposerContext,
  type SharedConversationComposerRouting,
} from '../lib/shared-conversation-composer';
import './ChatInputHost.css';

type InputSnapshot = {
  content: ReactNode;
  routing: SharedConversationComposerRouting;
  sink: ComposerStatusSink | null;
  statusActive: boolean;
  statusView: ComposerStatusView | null;
};

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
    let snapshot: InputSnapshot = {
      content: null,
      routing: null,
      sink: null,
      statusActive: false,
      statusView: null,
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
      snapshot = { ...snapshot, content: nextContent, routing };
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
      updateStatus(
        nextTarget: HTMLElement,
        sink: ComposerStatusSink | null,
        statusActive: boolean,
      ) {
        if (
          target !== nextTarget ||
          (snapshot.sink === sink && snapshot.statusActive === statusActive)
        )
          return;
        snapshot = { ...snapshot, sink, statusActive };
        listeners.forEach((listener) => listener());
      },
      updateRouting(nextTarget: HTMLElement, routing: SharedConversationComposerRouting) {
        update(nextTarget, snapshot.content, routing);
      },
      updateStatusView(nextTarget: HTMLElement, statusView: ComposerStatusView | null) {
        if (target !== nextTarget || snapshot.statusView === statusView) return;
        snapshot = { ...snapshot, statusView };
        listeners.forEach((listener) => listener());
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
  const sink = useComposerStatusSink();
  const statusActive = useContext(ActiveContext);
  const slot = useRef<HTMLDivElement>(null);
  const retained = host && host.sessionId === sessionId && host.hasRetained() ? host : null;
  useLayoutEffect(() => {
    if (retained && slot.current) return retained.attachRetained(slot.current);
  }, [retained]);
  useLayoutEffect(() => {
    if (retained && slot.current) {
      retained.updateRouting(
        slot.current,
        shared ?? {
          sourceConversationId: sessionId ?? '',
          props: { sendDisabledReason: 'Checking conversation status…' },
        },
      );
      retained.updateStatus(slot.current, sink, statusActive);
    }
  });
  return retained ? (
    <div className="chat-input-mount" ref={slot}>
      <ChatInputStatusBridge target={slot} host={retained} />
    </div>
  ) : (
    children
  );
}

/** The status reader lives inside ChatInput. Forward its view independently of
 * the input's props so reporting a notice cannot rerender and re-report itself. */
export function ChatInputStatusBridge({
  target,
  host,
}: {
  target: RefObject<HTMLElement | null>;
  host: NonNullable<ContextType<typeof ChatInputMountContext>>;
}) {
  const view = useContext(ViewContext);
  useEffect(() => {
    if (target.current) host.updateStatusView(target.current, view);
  }, [host, target, view]);
  return null;
}
function InputPortal({
  store,
}: {
  store: {
    container: HTMLElement;
    getSnapshot(): InputSnapshot;
    subscribe(listener: () => void): () => void;
  };
}) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return createPortal(
    <SharedConversationComposerContext.Provider value={snapshot.routing}>
      <SinkContext.Provider value={snapshot.sink}>
        <ViewContext.Provider value={snapshot.statusView}>
          <ActiveContext.Provider value={snapshot.statusActive}>
            {snapshot.content}
          </ActiveContext.Provider>
        </ViewContext.Provider>
      </SinkContext.Provider>
    </SharedConversationComposerContext.Provider>,
    store.container,
  );
}
