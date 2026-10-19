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
import { useTelosSourceNavigation } from './useTelosSourceNavigation';
import { readTelosItemHistory } from '../lib/telos-item-navigation';
import { readTelosChatReturn } from '../lib/telos-chat-return';
const api = new TelosWorkApiClient(apiFetch);

/** Select an authorized recorded association, never change the bound chat. */
export function useTelosChatRoute(conversationId: string | null) {
  const location = useLocation(),
    navigate = useNavigate();
  const query = new URLSearchParams(location.search);
  const sourceItem = query.get('telosItem'),
    sourceSnapshot = query.get('telosSource');
  const inspectingSource = !!sourceItem && !!sourceSnapshot;
  const source = useTelosSourceNavigation();
  const sourceStatus = inspectingSource
    ? source?.conversationId === conversationId &&
      source.itemId === sourceItem &&
      source.snapshotId === sourceSnapshot
      ? source.status
      : 'loading'
    : null;
  // The existing source owner validates the retained snapshot and conversation.
  // Its explicit inspected item takes precedence over any other bound work role.
  const requested = inspectingSource ? sourceItem : query.get('telosChatItem');
  const selectorKey = JSON.stringify([
    requested,
    inspectingSource ? sourceSnapshot : null,
    sourceStatus,
  ]);
  const connectionStatus = useMitzoStore((s) => s.connection.status);
  const [generation, setGeneration] = useState(0);
  const [result, setResult] = useState<{
    conversationId: string;
    selectorKey: string;
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
    const offConnection = eventBus.onConnectionChange((connected) => {
      if (connected) refresh();
    });
    document.addEventListener('visibilitychange', resume);
    return () => {
      off();
      offSessions();
      offConnection();
      document.removeEventListener('visibilitychange', resume);
    };
  }, []);
  useEffect(() => {
    if (!conversationId) return;
    if (inspectingSource && sourceStatus !== 'ready') {
      setResult({
        conversationId,
        selectorKey,
        itemId: null,
        ...(sourceStatus === 'unavailable' ? { error: 'Original exchange unavailable.' } : {}),
      });
      return;
    }
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
        setResult({ conversationId, selectorKey, itemId: null });
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
        selectorKey,
        itemId: linked ? selected : null,
        ...(!linked ? { error: 'The selected work item is not linked to this conversation.' } : {}),
      });
    })().catch(() => {
      if (!controller.signal.aborted)
        setResult({
          conversationId,
          selectorKey,
          itemId: null,
          error: selected ? 'Linked work unavailable.' : undefined,
        });
    });
    return () => controller.abort();
  }, [
    conversationId,
    requested,
    selectorKey,
    inspectingSource,
    sourceStatus,
    connectionStatus,
    generation,
  ]);
  const current =
    result?.conversationId === conversationId && result.selectorKey === selectorKey
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
  const localReturn = readTelosChatReturn(location.state, requested, location.pathname);
  const backState = localReturn
    ? localReturn.state
    : retained?.path === telosChatListPath(itemId ?? '')
      ? retained.state
      : location.state;
  return {
    data,
    error: current?.error ?? (itemId ? work.error : undefined),
    back: localReturn ?? (itemId ? { path: telosChatListPath(itemId), state: backState } : null),
    onChats: () => {
      if (itemId) navigate(telosChatListPath(itemId), { state: backState });
    },
    onItem: () => {
      if (itemId) navigate(`/todos/${encodeURIComponent(itemId)}`, { state: backState });
    },
    onOpen: (targetId: string, view?: 'Chat') => {
      if (!itemId) return;
      const history = readTelosItemHistory(itemId, backState?.telosHistory);
      navigate(`/todos/${encodeURIComponent(targetId)}${view ? '?view=Chat' : ''}`, {
        state: {
          ...backState,
          item: undefined,
          telosHistory: targetId === itemId ? history : [...history, itemId],
        },
      });
    },
  };
}
export type TelosChatRoute = ReturnType<typeof useTelosChatRoute>;
