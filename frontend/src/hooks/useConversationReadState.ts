import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ConversationReadState } from '@mitzo/protocol';
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
  useEffect(() => {
    if (!hydrate || current) return;
    let active = true;
    setFailure(undefined);
    void loadConversationReadState(id).catch((cause) => {
      if (active)
        setFailure({
          id,
          message: cause instanceof Error ? cause.message : 'Read status unavailable. Try again.',
        });
    });
    return () => {
      active = false;
    };
  }, [id, hydrate, current, attempt]);
  return {
    state: current,
    unread: isConversationUnread(current),
    loading: hydrate && !current && failure?.id !== id,
    error: !current && failure?.id === id ? failure.message : undefined,
    retry: () => setAttempt((value) => value + 1),
  };
}
