import { useEffect, useState } from 'react';
import { TelosWorkApiClient } from '@mitzo/client';
import { apiFetch } from '../lib/api-fetch';
import { Link } from 'react-router-dom';
import { useTodoData, findInTree } from '../hooks/useTodoData';
import { recordTitle } from '../lib/record-title';
import { UiIcon } from './UiIcon';
/** An exact recorded association, never inferred from a repo name or chat text. */
export function SessionWorkLink({ taskId }: { taskId: string }) {
  const todos = useTodoData(undefined, undefined, 'active', 'canonical');
  const item = findInTree(todos.items, taskId);
  return (
    <Link
      className="session-work-link"
      to={`/todos/${encodeURIComponent(taskId)}`}
      onClick={(event) => event.stopPropagation()}
      onTouchStart={(event) => event.stopPropagation()}
    >
      <UiIcon name="work" size={16} />
      {item ? recordTitle(item.summary) : 'View linked work'}
    </Link>
  );
}

const workApi = new TelosWorkApiClient(apiFetch);
/** All recorded associations, including several items sharing one origin. This
 * read cannot assign a lead or replace the chat's legacy single-session hint. */
export function ConversationWorkLinks({ conversationId }: { conversationId: string }) {
  const [result, setResult] = useState<{
    conversationId: string;
    itemIds: string[];
    error?: boolean;
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void workApi.links({ namespace: 'mitzo', conversationId }, controller.signal).then(
      (links) => {
        if (!controller.signal.aborted)
          setResult({ conversationId, itemIds: [...new Set(links.map((link) => link.itemId))] });
      },
      () => {
        if (!controller.signal.aborted) setResult({ conversationId, itemIds: [], error: true });
      },
    );
    return () => controller.abort();
  }, [conversationId]);
  if (result?.conversationId !== conversationId) return <p role="status">Loading linked work…</p>;
  if (result.error) return <p role="status">Linked work unavailable.</p>;
  if (!result.itemIds.length) return null;
  return (
    <>
      <h3>Linked work</h3>
      {result.itemIds.map((itemId) => (
        <div className="chat-resource-row" key={itemId}>
          <SessionWorkLink taskId={itemId} />
        </div>
      ))}
    </>
  );
}
