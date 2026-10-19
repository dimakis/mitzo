import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { TelosWorkApiClient } from '@mitzo/client';
import type { TelosChatRow } from '../lib/telos-chat-rows';
import { apiFetch } from '../lib/api-fetch';
import { telosChatReturnState } from '../lib/telos-chat-return';
const api = new TelosWorkApiClient(apiFetch);
export const telosChatListPath = (id: string) =>
  `/todos/${encodeURIComponent(id)}?view=Chat&chooseChat=1`;

export function useTelosChatOpen(itemId: string) {
  const navigate = useNavigate(),
    location = useLocation();
  const [error, setError] = useState('');
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => operation.current?.abort(), [itemId]);
  async function open(row: TelosChatRow) {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setError('');
    if (row.conversation.namespace === 'external_codex') {
      window.open(row.conversation.url, '_blank', 'noopener,noreferrer');
      return;
    }
    try {
      const selected = row.sources.filter((source) => source.selection.kind === 'selected');
      if (selected.length > 1) throw Error('Choose the exact original exchange in Materials.');
      let href = `/chat/${encodeURIComponent(row.conversation.conversationId)}`;
      if (selected.length === 1) {
        const source = await api.readSource(itemId, selected[0].snapshotId, controller.signal);
        if (!source.available)
          throw Error('Original exchange unavailable. Retained sources remain linked.');
        href = source.sourceHref;
      }
      if (controller.signal.aborted) return;
      const [path, query] = href.split('?');
      const params = new URLSearchParams(query);
      params.set('telosChatItem', itemId);
      navigate(`${path}?${params}`, {
        state: telosChatReturnState(
          location.state,
          itemId,
          row.conversation.conversationId,
          telosChatListPath(itemId),
        ),
      });
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : 'Conversation unavailable.');
    }
  }
  return { open, error };
}
