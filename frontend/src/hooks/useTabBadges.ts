import { useEffect, useMemo } from 'react';
import { useMitzoStore } from '@mitzo/client/hooks';
import { eventBus } from '../lib/event-bus-singleton';

export interface TabBadges {
  inboxCount: number;
  todoCount: number;
}

export function useTabBadges(): TabBadges {
  const inboxCount = useMitzoStore((s) => s.inbox.count);
  const todoItems = useMitzoStore((s) => s.todos.items);
  const loadInbox = useMitzoStore((s) => s.loadInbox);
  const loadTodos = useMitzoStore((s) => s.loadTodos);

  useEffect(() => {
    loadInbox();
    loadTodos();

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        loadInbox();
        loadTodos();
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    const unsubInbox = eventBus.on('inbox_updated', () => loadInbox());
    const unsubTodo = eventBus.on('todo_update', () => loadTodos());

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      unsubInbox();
      unsubTodo();
    };
  }, [loadInbox, loadTodos]);

  const todoCount = useMemo(
    () => (todoItems ?? []).filter((item) => item.status !== 'completed').length,
    [todoItems],
  );

  return { inboxCount, todoCount };
}
