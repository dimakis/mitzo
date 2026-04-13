import { useState, useEffect } from 'react';
import { wsSubscribe } from '../lib/ws-pool';

export interface TabBadges {
  inboxCount: number;
  todoCount: number;
}

export function useTabBadges(): TabBadges {
  const [inboxCount, setInboxCount] = useState(0);
  const [todoCount, setTodoCount] = useState(0);

  useEffect(() => {
    const fetchCounts = () =>
      Promise.all([
        fetch('/api/inbox')
          .then((r) => r.json())
          .catch(() => []),
        fetch('/api/todos')
          .then((r) => r.json())
          .catch(() => ({ items: [] })),
      ]).then(([inboxData, todoData]) => {
        if (Array.isArray(inboxData)) setInboxCount(inboxData.length);
        if (todoData?.items) {
          const pending = todoData.items.filter(
            (item: { status?: string }) => item.status !== 'completed',
          );
          setTodoCount(pending.length);
        }
      });

    fetchCounts();

    const onVisible = () => {
      if (document.visibilityState === 'visible') fetchCounts();
    };
    document.addEventListener('visibilitychange', onVisible);

    let inboxFetchTimer: ReturnType<typeof setTimeout> | null = null;
    const unsub = wsSubscribe('global:system', (msg) => {
      if (msg.type === 'inbox_updated') {
        if (inboxFetchTimer) clearTimeout(inboxFetchTimer);
        inboxFetchTimer = setTimeout(() => {
          fetch('/api/inbox')
            .then((r) => r.json())
            .then((data) => {
              if (Array.isArray(data)) setInboxCount(data.length);
            })
            .catch(() => {});
        }, 300);
      }
    });

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      if (inboxFetchTimer) clearTimeout(inboxFetchTimer);
      unsub();
    };
  }, []);

  return { inboxCount, todoCount };
}
