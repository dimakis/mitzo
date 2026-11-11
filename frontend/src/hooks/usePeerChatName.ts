import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { apiFetch, AUTH_RESTORED_EVENT } from '../lib/api-fetch';
import { eventBus } from '../lib/event-bus-singleton';
import { ListCache, SupersededListRequest } from '../lib/list-cache';

type ChatName = { name?: string; unavailable?: boolean; failed?: boolean };
// Presentation only. Revalidate on mount, rename, visibility and login;
// never use a cached label as authority to read or message a conversation.
const names = new ListCache<ChatName>();
eventBus.on('sessions_changed', () => names.invalidate());

export function usePeerChatName(sessionId: string, recordedName: string) {
  const subscribe = useCallback(
    (listener: () => void) => names.subscribe(sessionId, listener),
    [sessionId],
  );
  const snapshot = useCallback(() => names.get(sessionId), [sessionId]);
  const current = useSyncExternalStore(subscribe, snapshot);
  useEffect(() => {
    async function refresh() {
      try {
        await names.load(sessionId, async () => {
          try {
            const response = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/meta`, {
              signal: AbortSignal.timeout(10_000),
            });
            if (response.status === 404 || response.status === 410) return { unavailable: true };
            if (!response.ok) throw new Error(`peer_chat_name_http_${response.status}`);
            const meta = await response.json();
            if (
              meta.sessionId !== sessionId ||
              (meta.summary != null && typeof meta.summary !== 'string')
            )
              throw new Error('peer_chat_name_invalid_metadata');
            const name = meta.summary?.trim();
            return { name: name && name !== sessionId ? name : 'Untitled chat' };
          } catch (cause) {
            console.warn('Peer chat name could not be loaded', {
              code: 'peer_chat_name_failed',
              stage: 'metadata_read',
              sessionId,
              cause: cause instanceof Error ? cause.name : 'UnknownError',
            });
            return { name: names.get(sessionId)?.name, failed: true };
          }
        });
      } catch (cause) {
        // A rename or authentication boundary retires the old read. Its
        // replacement owns presentation; the old result must never be admitted.
        if (!(cause instanceof SupersededListRequest)) {
          console.warn('Peer chat name observation failed', {
            code: 'peer_chat_name_observation_failed',
            stage: 'presentation',
            sessionId,
            cause: cause instanceof Error ? cause.name : 'UnknownError',
          });
          names.set(sessionId, { ...names.get(sessionId), failed: true });
        }
      }
    }
    void refresh();
    const unsubscribe = eventBus.on('sessions_changed', () => void refresh());
    const visible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener(AUTH_RESTORED_EVENT, refresh);
    document.addEventListener('visibilitychange', visible);
    return () => {
      unsubscribe();
      window.removeEventListener(AUTH_RESTORED_EVENT, refresh);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [sessionId]);
  const recorded = recordedName.trim();
  return {
    name: current?.unavailable
      ? 'Unavailable chat'
      : current?.name || (recorded && recorded !== sessionId ? recorded : 'Chat'),
    failed: current?.failed,
  };
}
