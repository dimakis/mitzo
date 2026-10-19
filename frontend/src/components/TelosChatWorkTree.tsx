import { useNavigate } from 'react-router-dom';
import type { TelosChatRoute } from '../hooks/useTelosChatRoute';
import { useTodoData } from '../hooks/useTodoData';
import { useTelosRecords } from '../hooks/useTelosRecords';
import { useTaskBoard } from '../hooks/useTaskBoard';
import { TelosOutcomesTree } from './TelosOutcomesTree';
import { UiIcon } from './UiIcon';
import { taskStatusIcons } from '../lib/status-icons';
import type { Task } from '../types/task';

export function TelosChatWorkTree({
  conversationId,
  data,
}: {
  conversationId: string;
  data: NonNullable<TelosChatRoute['data']>;
}) {
  const navigate = useNavigate();
  const collection = useTodoData();
  const ids = [data.itemId];
  function collect(items: typeof collection.items) {
    for (const item of items) {
      ids.push(item.id);
      collect(item.children);
    }
  }
  collect(collection.items);
  const canonical = useTelosRecords(ids, data.refreshKey);
  const records = canonical.records.length ? canonical.records : [data.record];
  let root = records.find((r) => r.itemId === data.itemId) ?? data.record;
  const visited = new Set([root.itemId]);
  while (root.parentId && !visited.has(root.parentId)) {
    const parent = records.find((r) => r.itemId === root.parentId);
    if (!parent) break;
    root = parent;
    visited.add(root.itemId);
  }
  const related = new Set([root.itemId]);
  for (let i = 0; i < records.length; i++)
    for (const record of records)
      if (record.parentId && related.has(record.parentId)) related.add(record.itemId);
  const board = useTaskBoard();
  const taskIds = new Set(
    data.work.attempts
      .filter(
        (attempt) =>
          attempt.childItemId === data.itemId && attempt.workerConversationId === conversationId,
      )
      .flatMap((attempt) => (attempt.executionTaskId ? [attempt.executionTaskId] : [])),
  );
  function flatten(tasks: Task[]): Task[] {
    return tasks.flatMap((task) => [task, ...flatten(task.children ?? [])]);
  }
  const tasks = flatten(board.tasks).filter(
    (task) => taskIds.has(task.id) && task.sessionId === conversationId,
  );
  return (
    <>
      {(collection.error || canonical.unavailable.length > 0) && (
        <p role="status">Some related work is unavailable.</p>
      )}
      <TelosOutcomesTree
        compact
        records={records.filter((record) => related.has(record.itemId))}
        selectedId={data.itemId}
        storageKey={`telos.chat.tree.${data.itemId}`}
        refreshKey={canonical.refreshKey}
        onOpen={(id, view) =>
          navigate(`/todos/${encodeURIComponent(id)}${view ? '?view=Chat' : ''}`)
        }
      />
      {tasks.map((task) => (
        <p key={task.id} className="telos-chat-execution">
          <UiIcon name={taskStatusIcons[task.status]} size={16} />
          {task.status === 'pending_review'
            ? 'Awaiting review'
            : task.status === 'done'
              ? 'Task done'
              : `Task ${task.status}`}{' '}
          · {task.title}
        </p>
      ))}
    </>
  );
}
