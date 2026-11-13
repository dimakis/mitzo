import type { ConversationReadState } from '@mitzo/protocol';
import { apiFetch } from './api-fetch';
import { eventBus } from './event-bus-singleton';

const states = new Map<string, ConversationReadState>();
const listeners = new Set<() => void>();
const loads = new Map<string, Promise<ConversationReadState | undefined>>();
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

/** Coalesce missing off-page pin/menu observations within this auth generation. */
export function loadConversationReadState(id: string): Promise<ConversationReadState | undefined> {
  const prior = loads.get(id);
  if (prior) return prior;
  const captured = generation;
  const request = (async () => {
    try {
      const response = await apiFetch(`/api/sessions/${encodeURIComponent(id)}/read-state`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw Error('Read status unavailable');
      const state = parse(await response.json());
      if (captured !== generation) return;
      retainConversationReadState(id, state);
      return state;
    } catch (cause) {
      console.warn('Conversation read status unavailable', {
        code: 'conversation_read_unavailable',
        stage: 'observe',
        sessionId: id,
      });
      throw new Error('Read status unavailable. Try again.', { cause });
    }
  })().finally(() => {
    if (loads.get(id) === request) loads.delete(id);
  });
  loads.set(id, request);
  return request;
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
      current = await loadConversationReadState(id);
      if (captured !== generation) return;
    }
    if (!current) return;
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
  loads.clear();
  for (const listener of listeners) listener();
});
