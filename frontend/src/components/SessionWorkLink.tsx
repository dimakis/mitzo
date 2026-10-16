import { Link } from 'react-router-dom';
import { useTodoData, findInTree } from '../hooks/useTodoData';
import { recordTitle } from '../lib/record-title';
import { UiIcon } from './UiIcon';
/** An exact recorded association, never inferred from a repo name or chat text. */
export function SessionWorkLink({ taskId }: { taskId: string }) {
  const todos = useTodoData();
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
