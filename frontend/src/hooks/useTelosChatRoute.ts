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
  const connectionStatus = useMitzoStore((s) => s.connection.status);
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
    let selected: string | null = requested;
    void (async () => {
      const metadata = await apiFetch(`/api/sessions/${encodeURIComponent(conversationId)}/meta`, {
        signal: controller.signal,
      })
        .then(async (response) => (response.ok ? response.json() : null))
        .catch(() => null);
      if (controller.signal.aborted) return;
      const boundItem =
        metadata?.sessionId === conversationId ? metadata?.telosWorkRoleContext?.itemId : undefined;
      if (!selected && typeof boundItem === 'string' && boundItem.length > 0) selected = boundItem;
      // Unrelated ordinary chats keep their existing read path. Source inspection
      // carries its explicit item; ordinary roles retain theirs in owned metadata.
      if (!selected) {
        setResult({ conversationId, requested, itemId: null });
        return;
      }
      const links = await api.links({ namespace: 'mitzo', conversationId }, controller.signal);
      if (controller.signal.aborted) return;
      const linked = links.some(
        (link) =>
          link.itemId === selected &&
          link.conversation.namespace === 'mitzo' &&
          link.conversation.conversationId === conversationId,
      );
      setResult({
        conversationId,
        requested,
        itemId: linked ? selected : null,
        ...(!linked ? { error: 'The selected work item is not linked to this conversation.' } : {}),
      });
    })().catch(() => {
      if (!controller.signal.aborted)
        setResult({
          conversationId,
          requested,
          itemId: null,
          error: selected ? 'Linked work unavailable.' : undefined,
        });
    });
    return () => controller.abort();
  }, [conversationId, requested, connectionStatus, generation]);
  const current =
    result?.conversationId === conversationId && result.requested === requested
      ? result
      : undefined;
  const itemId = current?.itemId ?? null;
  const refreshKey = `${generation}:${connectionStatus}`;
  const work = useTelosChatWork(itemId, refreshKey);
  const records = useTelosRecords(itemId ? [itemId] : [], refreshKey);
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
      ? { itemId, work: work.work, record, refreshKey }
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
