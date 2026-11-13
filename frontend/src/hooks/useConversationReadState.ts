import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ConversationReadState } from '@mitzo/protocol';
import { eventBus } from '../lib/event-bus-singleton';
import {
  getConversationReadState,
  isConversationUnread,
  retainConversationReadState,
  subscribeConversationReads,
  loadConversationReadState,
} from '../lib/conversation-read-state';

export function useConversationReadState(
  id: string,
  observed?: ConversationReadState,
  hydrate = false,
) {
  const [failure, setFailure] = useState<{ id: string; message: string }>();
  const [attempt, setAttempt] = useState(0);
  const saved = useSyncExternalStore(
    subscribeConversationReads,
    () => getConversationReadState(id),
    () => undefined,
  );
  useEffect(() => retainConversationReadState(id, observed), [id, observed]);
  const current = !saved || (observed && observed.revision > saved.revision) ? observed : saved;
  const projected = observed !== undefined;
  useEffect(() => {
    if (!hydrate) return;
    let active = true;
    setFailure(undefined);
    if (projected) return;
    const refresh = () => {
      setFailure(undefined);
      void loadConversationReadState(id).catch((cause) => {
        if (active)
          setFailure({
            id,
            message: cause instanceof Error ? cause.message : 'Read status unavailable. Try again.',
          });
      });
    };
    // Off-page pins have no fresh list projection. Cached state survives while
    // each mount/reconnect reconciles changes made on another device.
    refresh();
    const unsubscribe = eventBus.onConnectionChange((connected) => {
      if (connected) refresh();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [id, hydrate, projected, attempt]);
  return {
    state: current,
    unread: isConversationUnread(current),
    loading: hydrate && !current && failure?.id !== id,
    error: failure?.id === id ? failure.message : undefined,
    retry: () => setAttempt((value) => value + 1),
  };
}
