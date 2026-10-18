import { useId, useRef, useState } from 'react';

interface TodoPrioritySelectProps {
  priority: number;
  onChange: (priority: number) => Promise<void>;
}

/** A confirmed value stays visible until the owner acknowledges the save. */
export function TodoPrioritySelect({ priority, onChange }: TodoPrioritySelectProps) {
  const errorId = useId();
  const pending = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(next: number) {
    if (pending.current || next === priority) return;
    pending.current = true;
    setSaving(true);
    setError(null);
    try {
      await onChange(next);
    } catch {
      setError('Couldn’t confirm this priority. Refresh to check its status.');
    } finally {
      pending.current = false;
      setSaving(false);
    }
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
