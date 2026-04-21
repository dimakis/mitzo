import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMitzoStore } from '@mitzo/client/hooks';
import { TodoCard } from '../components/TodoCard';
import { EmptyState } from '../components/EmptyState';
import { PageHeader } from '../components/PageHeader';
import { useTodoData } from '../hooks/useTodoData';
import { buildPrompt, buildTodoContext } from '../lib/todo-utils';
import type { TodoItem } from '../types/todo';

function TodoCreateForm({
  parentId,
  profile,
  profiles,
  onCreate,
  onCancel,
}: {
  parentId?: string;
  profile?: string;
  profiles: string[];
  onCreate: (summary: string, profile: string, parentId?: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [summary, setSummary] = useState('');
  const [selectedProfile, setSelectedProfile] = useState(profile || profiles[0] || '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = summary.trim();
    if (!text || !selectedProfile) return;
    await onCreate(text, selectedProfile, parentId);
    setSummary('');
    onCancel();
  }

  return (
    <form className="todo-create-form" onSubmit={handleSubmit}>
      <input
        ref={inputRef}
        className="todo-create-input"
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        placeholder={parentId ? 'Add sub-task...' : 'Add todo...'}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
        }}
      />
      {!profile && profiles.length > 1 && (
        <select
          className="todo-create-profile"
          value={selectedProfile}
          onChange={(e) => setSelectedProfile(e.target.value)}
        >
          {profiles.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      )}
      <div className="todo-create-actions">
        <button type="submit" className="todo-create-submit" disabled={!summary.trim()}>
          Add
        </button>
        <button type="button" className="todo-create-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function TodoView() {
  const navigate = useNavigate();
  const [activeProfile, setActiveProfile] = useState<string | undefined>(undefined);
  const { loading, items, profiles, ack, done, star, create, refresh } = useTodoData(activeProfile);
  const [creating, setCreating] = useState<{ parentId?: string } | null>(null);
  const setPendingSession = useMitzoStore((s) => s.setPendingSession);

  function handleStartSession(item: TodoItem) {
    setPendingSession({
      prompt: buildPrompt(item),
      context: buildTodoContext(item),
    });
    navigate('/chat');
  }

  function handleTap(item: TodoItem) {
    navigate(`/todos/${item.id}`, { state: { item } });
  }

  function handleAddChild(parentId: string) {
    setCreating({ parentId });
  }

  return (
    <div className="todo-page">
      <PageHeader title="Todos" badge={items.length || undefined}>
        <button
          className="todo-add-btn"
          onClick={() => setCreating({ parentId: undefined })}
          title="Add todo"
        >
          +
        </button>
        <button className="todo-refresh" onClick={refresh}>
          &#x21bb;
        </button>
      </PageHeader>

      <div className="todo-scroll">
        {profiles.length > 1 && (
          <div className="todo-filters">
            <button
              className={`todo-filter-pill${activeProfile === undefined ? ' todo-filter-pill--active' : ''}`}
              onClick={() => setActiveProfile(undefined)}
            >
              All
            </button>
            {profiles.map((p) => (
              <button
                key={p}
                className={`todo-filter-pill${activeProfile === p ? ' todo-filter-pill--active' : ''}`}
                onClick={() => setActiveProfile(activeProfile === p ? undefined : p)}
              >
                {p}
              </button>
            ))}
          </div>
        )}

        {creating && (
          <TodoCreateForm
            parentId={creating.parentId}
            profile={activeProfile}
            profiles={profiles}
            onCreate={create}
            onCancel={() => setCreating(null)}
          />
        )}

        {loading && <p className="todo-empty">Loading...</p>}

        {!loading && items.length === 0 && (
          <EmptyState
            icon={'\u2713'}
            title="No active items"
            subtitle={
              <>
                Run <code>./mgmt todo --refresh</code> to fetch from sources
              </>
            }
          />
        )}

        <div className="todo-hint">
          {items.length > 0 && <span>Tap to start working. Swipe right = seen, left = done.</span>}
        </div>

        <div className="todo-list">
          {items.map((item) => (
            <TodoCard
              key={item.id}
              item={item}
              onAck={ack}
              onDone={done}
              onStar={star}
              onTap={handleTap}
              onAddChild={handleAddChild}
              onStartSession={handleStartSession}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
