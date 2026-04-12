import { useState, useRef, useEffect } from 'react';

interface TaskCreateFormProps {
  parentId?: string;
  onCreate: (title: string, parentId?: string) => void;
  onCancel: () => void;
}

export function TaskCreateForm({ parentId, onCreate, onCancel }: TaskCreateFormProps) {
  const [title, setTitle] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = title.trim();
    if (!text) return;
    onCreate(text, parentId);
    setTitle('');
  }

  return (
    <form className="task-create-form" onSubmit={handleSubmit}>
      <input
        ref={inputRef}
        className="task-create-input"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={parentId ? 'Add sub-task...' : 'Add task...'}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
        }}
      />
      <div className="task-create-actions">
        <button type="submit" className="task-create-submit" disabled={!title.trim()}>
          Add
        </button>
        <button type="button" className="task-create-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
