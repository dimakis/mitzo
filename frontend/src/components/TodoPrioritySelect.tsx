import { useId, useMemo, useSyncExternalStore } from 'react';

import {
  createTodoPrioritySaveState,
  type TodoPrioritySaveState,
} from '../lib/todo-priority-save-state';

interface TodoPrioritySelectProps {
  priority: number;
  onChange: (priority: number) => Promise<void>;
  saveState?: TodoPrioritySaveState;
}

/** A confirmed value stays visible until the owner acknowledges the save. */
export function TodoPrioritySelect({ priority, onChange, saveState }: TodoPrioritySelectProps) {
  const errorId = useId();
  const local = useMemo(() => createTodoPrioritySaveState(), []);
  const owner = saveState ?? local;
  const { saving, error } = useSyncExternalStore(
    owner.subscribe,
    owner.getSnapshot,
    owner.getSnapshot,
  );

  function save(next: number) {
    if (next !== priority) void owner.save(() => onChange(next));
  }

  return (
    <div className="todo-priority-control">
      <label className="todo-detail-priority">
        <span>Priority</span>
        <select
          value={priority}
          disabled={saving}
          aria-busy={saving}
          aria-describedby={error ? errorId : undefined}
          onChange={(event) => void save(Number(event.currentTarget.value))}
        >
          {Array.from({ length: 10 }, (_, index) => index + 1).map((value) => (
            <option key={value} value={value}>
              {value} / 10
            </option>
          ))}
        </select>
      </label>
      {error && (
        <span id={errorId} className="todo-priority-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
