import type { ConversationReadState } from '@mitzo/protocol';
import { apiFetch } from './api-fetch';
import { eventBus } from './event-bus-singleton';

const states = new Map<string, ConversationReadState>();
const listeners = new Set<() => void>();
let generation = 0;
export const subscribeConversationReads = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const getConversationReadState = (id: string) => states.get(id);
export const isConversationUnread = (state?: ConversationReadState) =>
  !!state && (state.markedUnread || state.latestReplySeq > state.readReplySeq);

export function retainConversationReadState(id: string, state?: ConversationReadState) {
  if (!state) return;
  const previous = states.get(id);
  const next = !previous || state.revision > previous.revision ? state : previous;
  const latestReplySeq = Math.max(previous?.latestReplySeq ?? 0, state.latestReplySeq);
  if (previous && next === previous && latestReplySeq === previous.latestReplySeq) return;
  states.set(id, { ...next, latestReplySeq });
  for (const listener of listeners) listener();
}

function parse(data: unknown): ConversationReadState {
  const state = data as ConversationReadState;
  if (
    !state ||
    ![state.latestReplySeq, state.readReplySeq, state.revision].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) ||
    typeof state.markedUnread !== 'boolean'
  )
    throw Error('Invalid read status');
  return state;
}

export async function changeConversationReadState(
  id: string,
  update: { readReplySeq: number } | { markedUnread: true },
  observed?: ConversationReadState,
) {
  const captured = generation;
  const url = `/api/sessions/${encodeURIComponent(id)}/read-state`;
  try {
    retainConversationReadState(id, observed);
    let current = states.get(id);
    if (!current) {
      const response = await apiFetch(url, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw Error('Read status unavailable');
      current = parse(await response.json());
      if (captured !== generation) return;
      retainConversationReadState(id, current);
    }
    if (captured !== generation) return;
    const response = await apiFetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...update, expectedRevision: current.revision }),
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 409) {
      const refreshed = await apiFetch(url, { signal: AbortSignal.timeout(5000) });
      if (refreshed.ok) {
        const state = parse(await refreshed.json());
        if (captured === generation) retainConversationReadState(id, state);
      }
    }
    if (!response.ok)
      throw Error(
        response.status === 409
          ? 'Read status changed. Try again.'
          : 'Couldn’t save read status. Try again.',
      );
    const state = parse(await response.json());
    if (captured === generation) retainConversationReadState(id, state);
    return state;
  } catch (cause) {
    console.warn('Conversation read status failed', {
      code: 'conversation_read_failed',
      stage: 'save',
      sessionId: id,
    });
    throw new Error('Couldn’t save read status. Try again.', { cause });
  }
}

eventBus.on('session_read_state', (data) => {
  const event = data as { sessionId?: string; state?: unknown };
  try {
    if (typeof event.sessionId !== 'string') throw Error('Invalid session');
    retainConversationReadState(event.sessionId, parse(event.state));
  } catch (cause) {
    console.warn('Invalid conversation read event', {
      code: 'conversation_read_event_invalid',
      errorType: cause instanceof Error ? cause.name : typeof cause,
    });
  }
});
window.addEventListener('mitzo:auth-lost', () => {
  generation++;
  states.clear();
  for (const listener of listeners) listener();
});
