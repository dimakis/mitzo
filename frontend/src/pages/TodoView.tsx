import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useMitzoStore } from '@mitzo/client/hooks';
import { TodoCard } from '../components/TodoCard';
import { EmptyState } from '../components/EmptyState';
import { PageHeader } from '../components/PageHeader';
import { useTodoData } from '../hooks/useTodoData';
import { buildPrompt, buildTodoContext } from '../lib/todo-utils';
import type { TodoItem, TodoOutcomeDraft } from '../types/todo';

// ─── Section grouping ──────────────────────────────────────────────────────

interface TodoSection {
  key: string;
  label: string;
  items: TodoItem[];
  defaultCollapsed: boolean;
}

type TodoSort = 'priority' | 'newest' | 'oldest' | 'title';

function groupIntoSections(items: TodoItem[], sort: TodoSort): TodoSection[] {
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

  // Sort within sections — intentional direction differences:
  // Focus/Active: highest urgency first, tie-break by newest (lower ageDays)
  // Seen: oldest first (longest-waiting items surface)
  // Done: newest first (most recent completions on top for review)
  const comparator =
    sort === 'newest'
      ? (a: TodoItem, b: TodoItem) => a.ageDays - b.ageDays
      : sort === 'oldest'
        ? (a: TodoItem, b: TodoItem) => b.ageDays - a.ageDays
        : sort === 'title'
          ? (a: TodoItem, b: TodoItem) => a.summary.localeCompare(b.summary)
          : (a: TodoItem, b: TodoItem) => b.urgency - a.urgency || a.ageDays - b.ageDays;
  focus.sort(comparator);
  active.sort(comparator);
  seen.sort(comparator);
  done.sort(comparator);

  const sections: TodoSection[] = [];
  if (focus.length > 0)
    sections.push({ key: 'focus', label: 'Focus', items: focus, defaultCollapsed: false });
  if (active.length > 0)
    sections.push({ key: 'active', label: 'Active', items: active, defaultCollapsed: false });
  if (seen.length > 0)
    sections.push({ key: 'seen', label: 'Seen', items: seen, defaultCollapsed: false });
  if (done.length > 0)
    sections.push({ key: 'done', label: 'Done', items: done, defaultCollapsed: true });

  return sections;
}

// ─── Create form ───────────────────────────────────────────────────────────

function TodoCreateForm({
  parentId,
  profile,
  profiles,
  onCreate,
  onCreateOutcome,
  onCancel,
}: {
  parentId?: string;
  profile?: string;
  profiles: string[];
  onCreate: (summary: string, profile: string, parentId?: string) => Promise<void>;
  onCreateOutcome: (draft: TodoOutcomeDraft) => Promise<TodoItem | undefined>;
  onCancel: () => void;
}) {
  const [summary, setSummary] = useState('');
  const [intent, setIntent] = useState('');
  const [rationale, setRationale] = useState('');
  const [criteria, setCriteria] = useState('');
  const [milestones, setMilestones] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [selectedProfile, setSelectedProfile] = useState(profile || profiles[0] || '');
  const idempotencyKey = useRef(
    globalThis.crypto?.randomUUID?.() ?? `telos-${Date.now()}-${Math.random()}`,
  );
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = summary.trim();
    if (!text || !selectedProfile) return;
    setCreateError(null);
    setSubmitting(true);
    try {
      if (parentId) {
        await onCreate(text, selectedProfile, parentId);
      } else {
        const acceptanceCriteria = criteria
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        const milestoneItems = milestones
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        if (
          !intent.trim() ||
          !rationale.trim() ||
          !acceptanceCriteria.length ||
          !milestoneItems.length
        )
          return;
        const created = await onCreateOutcome({
          summary: text,
          intent: intent.trim(),
          rationale: rationale.trim(),
          acceptanceCriteria,
          milestones: milestoneItems,
          profile: selectedProfile,
          idempotencyKey: idempotencyKey.current,
        });
        if (!created) {
          setCreateError('Unable to create outcome. Your draft has been kept.');
          return;
        }
      }
      setSummary('');
      onCancel();
    } catch {
      setCreateError('Unable to create outcome. Your draft has been kept.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="todo-create-form" onSubmit={handleSubmit}>
      <input
        ref={inputRef}
        className="todo-create-input"
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        placeholder={parentId ? 'Add milestone…' : 'Short outcome title'}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
        }}
      />
      {!parentId && (
        <>
          <textarea
            className="todo-create-input todo-create-textarea"
            value={intent}
            onChange={(event) => setIntent(event.target.value)}
            placeholder="What will be true when this is achieved?"
          />
          <textarea
            className="todo-create-input todo-create-textarea"
            value={rationale}
            onChange={(event) => setRationale(event.target.value)}
            placeholder="Why does this matter?"
          />
          <textarea
            className="todo-create-input todo-create-textarea"
            value={criteria}
            onChange={(event) => setCriteria(event.target.value)}
            placeholder={'Done when — one verifiable criterion per line'}
          />
          <textarea
            className="todo-create-input todo-create-textarea"
            value={milestones}
            onChange={(event) => setMilestones(event.target.value)}
            placeholder={'Milestones — first line is the next action'}
          />
        </>
      )}
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
      {createError && (
        <div className="todo-create-error" role="alert">
          {createError}
        </div>
      )}
      <div className="todo-create-actions">
        <button
          type="submit"
          className="todo-create-submit"
          disabled={
            !summary.trim() ||
            submitting ||
            (!parentId &&
              (!intent.trim() || !rationale.trim() || !criteria.trim() || !milestones.trim()))
          }
        >
          {submitting ? 'Creating…' : parentId ? 'Add milestone' : 'Create outcome'}
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

export function TodoView({ selectedId }: { selectedId?: string } = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  const restoredProfile = (location.state as { activeProfile?: string } | null)?.activeProfile;
  const [activeProfile, setActiveProfile] = useState<string | undefined>(restoredProfile);
  const { loading, error, items, profiles, ack, done, star, create, createOutcome, refresh } =
    useTodoData(activeProfile);
  const [creating, setCreating] = useState<{ parentId?: string } | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<TodoSort>('priority');
  const setPendingSession = useMitzoStore((s) => s.setPendingSession);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({
    done: true,
  });

  const filteredItems = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return items;
    const matches = (item: TodoItem): boolean => {
      const searchable = [
        item.summary,
        item.intent ?? '',
        item.rationale ?? '',
        ...(item.acceptanceCriteria ?? []),
        ...item.contextHints.repos,
        ...item.contextHints.paths,
        ...item.contextHints.issues,
        ...item.contextHints.jiraKeys,
        ...item.contextHints.keywords,
      ];
      return (
        searchable.some((value) => value.toLocaleLowerCase().includes(needle)) ||
        item.children.some(matches)
      );
    };
    return items.filter(matches);
  }, [items, query]);
  const sections = useMemo(() => groupIntoSections(filteredItems, sort), [filteredItems, sort]);

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
      telosTaskId: item.id,
      agentName: 'mitzo-telos',
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
        <div className="todo-toolbar">
          <label className="todo-search">
            <span aria-hidden="true">⌕</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search outcomes, context, files…"
              aria-label="Search Telos items"
            />
          </label>
          <select
            className="todo-sort"
            value={sort}
            onChange={(event) => setSort(event.target.value as TodoSort)}
            aria-label="Sort Telos items"
          >
            <option value="priority">Priority</option>
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="title">Title</option>
          </select>
        </div>
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
            onCreateOutcome={createOutcome}
            onCancel={() => setCreating(null)}
          />
        )}

        {loading && <p className="todo-empty">Loading...</p>}

        {!loading && error && (
          <EmptyState icon="!" title={error} subtitle="Tap refresh to try again" />
        )}

        {!loading && !error && items.length === 0 && (
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

        {!loading && !error && items.length > 0 && filteredItems.length === 0 && (
          <EmptyState icon="⌕" title="No matching outcomes" subtitle="Try a broader search" />
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
                      selectedId={selectedId}
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
