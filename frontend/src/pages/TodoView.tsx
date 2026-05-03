import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useMitzoStore } from '@mitzo/client/hooks';
import { TodoCard } from '../components/TodoCard';
import { EmptyState } from '../components/EmptyState';
import { PageHeader } from '../components/PageHeader';
import { useTodoData } from '../hooks/useTodoData';
import { buildPrompt, buildTodoContext } from '../lib/todo-utils';
import type { TodoItem } from '../types/todo';

// ─── Section grouping ──────────────────────────────────────────────────────

interface TodoSection {
  key: string;
  label: string;
  items: TodoItem[];
  defaultCollapsed: boolean;
}

function groupIntoSections(items: TodoItem[]): TodoSection[] {
  const focus: TodoItem[] = [];
  const active: TodoItem[] = [];
  const seen: TodoItem[] = [];
  const done: TodoItem[] = [];

  for (const item of items) {
    if (item.status === 'completed') {
      done.push(item);
    } else if (item.status === 'acknowledged') {
      seen.push(item);
    } else if (item.starred && item.urgency >= 0.5) {
      focus.push(item);
    } else {
      active.push(item);
    }
  }

  // Sort within sections
  const byUrgencyDesc = (a: TodoItem, b: TodoItem) => b.urgency - a.urgency || a.ageDays - b.ageDays;
  focus.sort(byUrgencyDesc);
  active.sort(byUrgencyDesc);
  seen.sort((a, b) => a.ageDays - b.ageDays); // oldest first
  done.sort((a, b) => b.ageDays - a.ageDays); // newest first

  const sections: TodoSection[] = [];
  if (focus.length > 0) sections.push({ key: 'focus', label: 'Focus', items: focus, defaultCollapsed: false });
  if (active.length > 0) sections.push({ key: 'active', label: 'Active', items: active, defaultCollapsed: false });
  if (seen.length > 0) sections.push({ key: 'seen', label: 'Seen', items: seen, defaultCollapsed: false });
  if (done.length > 0) sections.push({ key: 'done', label: 'Done', items: done, defaultCollapsed: true });

  return sections;
}

// ─── Create form ───────────────────────────────────────────────────────────

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

// ─── Section header ────────────────────────────────────────────────────────

function SectionHeader({
  label,
  count,
  collapsed,
  onToggle,
}: {
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button className="todo-section-header" onClick={onToggle}>
      <span className="todo-section-label">{label}</span>
      <span className="todo-section-count">{count}</span>
      <span className="todo-section-line" />
      <span className={`todo-section-chevron${collapsed ? '' : ' todo-section-chevron--open'}`}>
        &rsaquo;
      </span>
    </button>
  );
}

// ─── Main view ─────────────────────────────────────────────────────────────

export function TodoView() {
  const navigate = useNavigate();
  const location = useLocation();
  const restoredProfile = (location.state as { activeProfile?: string } | null)?.activeProfile;
  const [activeProfile, setActiveProfile] = useState<string | undefined>(restoredProfile);
  const { loading, items, profiles, ack, done, star, create, refresh } = useTodoData(activeProfile);
  const [creating, setCreating] = useState<{ parentId?: string } | null>(null);
  const setPendingSession = useMitzoStore((s) => s.setPendingSession);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({
    done: true,
  });

  const sections = useMemo(() => groupIntoSections(items), [items]);

  // Restore scroll position when returning from detail view
  useEffect(() => {
    const saved = (location.state as { scrollTop?: number } | null)?.scrollTop;
    if (saved && scrollRef.current) {
      scrollRef.current.scrollTop = saved;
    }
  }, [location.state]);

  const saveScrollPosition = useCallback(() => {
    return scrollRef.current?.scrollTop ?? 0;
  }, []);

  function toggleSection(key: string) {
    setCollapsedSections((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function handleStartSession(item: TodoItem) {
    setPendingSession({
      prompt: buildPrompt(item),
      context: buildTodoContext(item),
    });
    navigate('/chat');
  }

  function handleTap(item: TodoItem) {
    navigate(`/todos/${item.id}`, {
      state: { item, activeProfile, scrollTop: saveScrollPosition() },
    });
  }

  function handleAddChild(parentId: string) {
    setCreating({ parentId });
  }

  return (
    <div className="todo-page">
      <PageHeader title="Telos" badge={items.length || undefined}>
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

      <div className="todo-scroll" ref={scrollRef}>
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

        {sections.map((section) => {
          const isCollapsed = collapsedSections[section.key] ?? section.defaultCollapsed;
          return (
            <div key={section.key} className="todo-section">
              <SectionHeader
                label={section.label}
                count={section.items.length}
                collapsed={isCollapsed}
                onToggle={() => toggleSection(section.key)}
              />
              {!isCollapsed && (
                <div className="todo-list">
                  {section.items.map((item) => (
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
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
