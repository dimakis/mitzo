import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { TelosWorkApiClient } from '@mitzo/client';
import { useMitzoStore } from '@mitzo/client/hooks';
import { useTelosChatWork } from './useTelosChatWork';
import { useTelosRecords } from './useTelosRecords';
import { telosChatRows } from '../lib/telos-chat-rows';
import { telosChatListPath } from './useTelosChatOpen';
import { apiFetch } from '../lib/api-fetch';
import { eventBus } from '../lib/event-bus-singleton';
const api = new TelosWorkApiClient(apiFetch);

/** Select an authorized recorded association, never change the bound chat. */
export function useTelosChatRoute(conversationId: string | null) {
  const location = useLocation(),
    navigate = useNavigate();
  const requested = new URLSearchParams(location.search).get('telosChatItem');
  const connected = useMitzoStore((s) => s.connected);
  const [generation, setGeneration] = useState(0);
  const [result, setResult] = useState<{
    conversationId: string;
    requested: string | null;
    itemId: string | null;
    error?: string;
  }>();
  useEffect(() => {
    const refresh = () => setGeneration((v) => v + 1);
    const resume = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    const off = eventBus.on('todo_update', refresh),
      offSessions = eventBus.on('sessions_changed', refresh);
    document.addEventListener('visibilitychange', resume);
    return () => {
      off();
      offSessions();
      document.removeEventListener('visibilitychange', resume);
    };
  }, []);
  useEffect(() => {
    if (!conversationId) return;
    const controller = new AbortController();
    void Promise.all([
      api.links({ namespace: 'mitzo', conversationId }, controller.signal),
      apiFetch(`/api/sessions/${encodeURIComponent(conversationId)}/meta`, {
        signal: controller.signal,
      })
        .then(async (response) => (response.ok ? response.json() : null))
        .catch(() => null),
    ]).then(
      ([links, metadata]) => {
        if (controller.signal.aborted) return;
        const ids = [
          ...new Set(
            links
              .filter(
                (link) =>
                  link.conversation.namespace === 'mitzo' &&
                  link.conversation.conversationId === conversationId,
              )
              .map((link) => link.itemId),
          ),
        ];
        const boundItem =
          metadata?.sessionId === conversationId
            ? metadata?.telosWorkRoleContext?.itemId
            : undefined;
        const selected =
          requested ??
          (typeof boundItem === 'string' && ids.includes(boundItem)
            ? boundItem
            : ids.length === 1
              ? ids[0]
              : null);
        setResult({
          conversationId,
          requested,
          itemId: selected && ids.includes(selected) ? selected : null,
          ...(selected && !ids.includes(selected)
            ? { error: 'The selected work item is not linked to this conversation.' }
            : {}),
        });
      },
      () => {
        if (!controller.signal.aborted)
          setResult({
            conversationId,
            requested,
            itemId: null,
            error: requested ? 'Linked work unavailable.' : undefined,
          });
      },
    );
    return () => controller.abort();
  }, [conversationId, requested, connected, generation]);
  const current =
    result?.conversationId === conversationId && result.requested === requested
      ? result
      : undefined;
  const itemId = current?.itemId ?? null;
  const work = useTelosChatWork(itemId, generation);
  const records = useTelosRecords(itemId ? [itemId] : []);
  const record = records.records.find((value) => value.itemId === itemId);
  const data =
    itemId &&
    work.work &&
    record &&
    telosChatRows(work.work).some(
      (row) =>
        row.conversation.namespace === 'mitzo' &&
        row.conversation.conversationId === conversationId,
    )
      ? { itemId, work: work.work, record }
      : null;
  const retained = location.state?.telosChatReturn;
  const backState =
    retained?.path === telosChatListPath(itemId ?? '') ? retained.state : location.state;
  return {
    data,
    error: current?.error ?? (itemId ? work.error : undefined),
    back: itemId ? { path: telosChatListPath(itemId), state: backState } : null,
    onChats: () => {
      if (itemId) navigate(telosChatListPath(itemId), { state: backState });
    },
    onItem: () => {
      if (itemId) navigate(`/todos/${encodeURIComponent(itemId)}`, { state: backState });
    },
  };
}
export type TelosChatRoute = ReturnType<typeof useTelosChatRoute>;
