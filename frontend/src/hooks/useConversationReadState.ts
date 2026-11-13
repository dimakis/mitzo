import { useEffect, useSyncExternalStore } from 'react';
import type { ConversationReadState } from '@mitzo/protocol';
import {
  getConversationReadState,
  isConversationUnread,
  retainConversationReadState,
  subscribeConversationReads,
} from '../lib/conversation-read-state';

export function useConversationReadState(id: string, observed?: ConversationReadState) {
  const saved = useSyncExternalStore(
    subscribeConversationReads,
    () => getConversationReadState(id),
    () => undefined,
  );
  useEffect(() => retainConversationReadState(id, observed), [id, observed]);
  const current = !saved || (observed && observed.revision > saved.revision) ? observed : saved;
  return { state: current, unread: isConversationUnread(current) };
}
