import { WorkspaceActionMenu } from '../components/WorkspaceActionMenu';
import { parseTelosCollectionView, telosCollectionPath } from '../lib/telos-collection-view';
import { useMitzoStore } from '@mitzo/client/hooks';
import { newChatPathWithDraft } from '../lib/chat-drafts';
import { TelosOutcomesTree } from '../components/TelosOutcomesTree';
import { useTelosRecords } from '../hooks/useTelosRecords';
import { useStageChatLaunch } from '../hooks/useStageChatLaunch';
import { UiIcon } from '../components/UiIcon';
import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { TodoCard } from '../components/TodoCard';
import { EmptyState } from '../components/EmptyState';
import { WorkspacePageHeading } from '../components/WorkspacePageHeading';
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

export function TodoCreateForm({
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
        <UiIcon name="forward" size={16} />
      </span>
    </button>
  );
}

// ─── Main view ─────────────────────────────────────────────────────────────

export function TodoView({ selectedId }: { selectedId?: string } = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  const collectionView = parseTelosCollectionView(new URLSearchParams(location.search).get('view'));
  const collectionTitle =
    collectionView === 'archive'
      ? 'Archived outcomes'
      : collectionView === 'trash'
        ? 'Trash'
        : 'Telos outcomes';
  const collectionMenu = (
    <WorkspaceActionMenu
      label="Outcome views"
      items={(['active', 'archive', 'trash'] as const).map((view) => ({
        id: view,
        label: view === 'active' ? 'Active' : view === 'archive' ? 'Archive' : 'Trash',
        checked: view === collectionView,
        onSelect: () =>
          navigate(telosCollectionPath(view), {
            state: { ...location.state, telosCollectionView: view, scrollTop: 0 },
          }),
      }))}
    />
  );
  const restoredProfile = (location.state as { activeProfile?: string } | null)?.activeProfile;
  const [activeProfile, setActiveProfile] = useState<string | undefined>(restoredProfile);
  // Canonical discovery covers every profile; the legacy selection remains a
  // fallback preference, including when restored through item navigation.
  const discovery = useTodoData(undefined, undefined, collectionView, 'canonical');
  const { loading, error, items, profiles, ack, done, create, createOutcome } = useTodoData(
    activeProfile,
    undefined,
    collectionView,
    'legacy',
    Boolean(discovery.error),
  );
  const [creating, setCreating] = useState<{ parentId?: string } | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<TodoSort>('priority');
  const setPendingSession = useStageChatLaunch();
  const newSession = useMitzoStore((state) => state.newSession);
  const [planningError, setPlanningError] = useState('');
  function startPlanning() {
    try {
      const path = newChatPathWithDraft(
        'Help me plan a new Telos outcome. Ask questions before proposing its outcome, why it matters and done-when criteria. Save a draft only after I review it, retaining this planning conversation and agreed exchange as its source. Do not start work.',
      );
      newSession();
      navigate(path);
    } catch (error) {
      setPlanningError(
        error instanceof Error ? error.message : 'Planning conversation unavailable.',
      );
    }
  }
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
        ...item.contextHints.docIds,
        ...item.contextHints.people,
        ...item.contextHints.jiraKeys,
        ...item.contextHints.keywords,
        item.contextHints.taskHint,
        ...(item.contextHints.sessionIds ?? []),
        ...(item.links ?? []).flatMap((link) => [
          link.type,
          link.url,
          link.title,
          link.description,
        ]),
        ...item.sources.flatMap((source) => [
          source.type,
          source.url,
          source.title,
          source.author,
          source.snippet,
        ]),
      ];
      return (
        searchable.some((value) => value.toLocaleLowerCase().includes(needle)) ||
        item.children.some(matches)
      );
    };
    return items.filter(matches);
  }, [items, query]);
  const sections = useMemo(() => groupIntoSections(filteredItems, sort), [filteredItems, sort]);

  const recordIds: string[] = [];
  const recordOriginals = new Map<string, TodoItem>();
  function collectIds(values: TodoItem[]) {
    for (const item of values) {
      recordIds.push(item.id);
      recordOriginals.set(item.id, item);
      collectIds(item.children);
    }
  }
  collectIds(discovery.items);
  const canonical = useTelosRecords(
    [...recordIds, ...(discovery.recordFailures ?? []).map((failure) => failure.itemId)],
    discovery.refreshKey,
    {
      batch: true,
      seed: discovery.error ? undefined : discovery.records,
      loading: discovery.loading,
      failures: discovery.recordFailures,
    },
  );
  function refreshWorkspace() {
    discovery.refresh();
  }

  // A short fallback or rows still growing cannot yet hold the saved offset.
  // Keep this navigation's target through layout changes until user input owns it.
  const restoredLocation = useRef<string | null>(null);
  const scrollContentReady = !discovery.loading && !canonical.loading;
  useLayoutEffect(() => {
    if (restoredLocation.current === location.key) return;
    const saved = (location.state as { scrollTop?: number } | null)?.scrollTop;
    const container = scrollRef.current;
    if (typeof saved !== 'number' || !Number.isFinite(saved) || saved < 0 || !container) return;
    const inputScope = container.parentElement ?? container;
    const inputs = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
    let watching = true;
    let observer: ResizeObserver | undefined;
    function cleanup() {
      watching = false;
      observer?.disconnect();
      for (const input of inputs) inputScope.removeEventListener(input, takeControl);
    }
    function takeControl() {
      restoredLocation.current = location.key;
      cleanup();
    }
    const restore = () => {
      if (!watching) return;
      container.scrollTop = saved;
      if (Math.abs(container.scrollTop - saved) <= 1) restoredLocation.current = location.key;
    };
    if (scrollContentReady && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(restore);
      observer.observe(container);
      for (const child of container.children) observer.observe(child);
    }
    for (const input of inputs) inputScope.addEventListener(input, takeControl, { passive: true });
    if (scrollContentReady) {
      restore();
      if (!observer) takeControl();
    }
    return cleanup;
  }, [location.key, location.state, scrollContentReady]);

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
  }

  function handleTap(item: TodoItem) {
    navigate(`/todos/${item.id}`, {
      state: {
        ...location.state,
        item,
        activeProfile,
        scrollTop: saveScrollPosition(),
        telosHistory: [],
        ...(collectionView === 'active' ? {} : { telosCollectionView: collectionView }),
      },
    });
  }

  function handleAddChild(parentId: string) {
    setCreating({ parentId });
  }

  if (
    canonical.initializing ||
    canonical.records.length > 0 ||
    (discovery.items.length === 0 && items.length === 0)
  )
    return (
      <div className="todo-page telos-canonical-page">
        <div className="todo-collection-heading">
          <WorkspacePageHeading
            title={collectionTitle}
            description="Your outcomes, their child work and the coordinators connecting them."
            actions={
              <div className="todo-collection-actions">
                {collectionMenu}
                <button className="todo-add-btn" onClick={startPlanning}>
                  New item
                </button>
                <button
                  className="todo-refresh"
                  onClick={refreshWorkspace}
                  aria-label="Refresh Telos"
                >
                  <UiIcon name="retry" size={16} />
                </button>
              </div>
            }
          />
        </div>
        <div className="todo-scroll" ref={scrollRef}>
          {planningError && <p role="alert">{planningError}</p>}
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

          {discovery.error && canonical.records.length > 0 && (
            <p role="alert">{discovery.error} Displayed records may be stale.</p>
          )}
          {canonical.unavailable.length > 0 && (
            <div role="alert" className="telos-unavailable-records">
              <p>Some outcomes are unavailable. ({canonical.unavailable.length})</p>
              <ul>
                {canonical.failures.map((failure) => {
                  const original = recordOriginals.get(failure.itemId);
                  return (
                    <li key={failure.itemId}>
                      {original ? (
                        <button className="telos-node-title" onClick={() => handleTap(original)}>
                          {original.summary}
                        </button>
                      ) : (
                        <span>{failure.itemId}</span>
                      )}
                      <span>
                        {' '}
                        · {failure.itemId} · {failure.status ? `HTTP ${failure.status} · ` : ''}
                        {failure.code}.{' '}
                        {original
                          ? 'Original fields remain available.'
                          : 'Original fields unavailable.'}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <button className="home-secondary" onClick={refreshWorkspace}>
                Retry unavailable outcomes
              </button>
            </div>
          )}
          <TelosOutcomesTree
            records={canonical.records}
            refreshKey={canonical.refreshKey}
            loading={discovery.loading || canonical.loading}
            error={discovery.error && canonical.records.length === 0 ? discovery.error : undefined}
            selectedId={selectedId}
            onOpen={(id, view) => {
              if (view) {
                try {
                  sessionStorage.setItem('telos.item.tab.' + id, view);
                } catch {
                  /* Entry remains navigable without device preferences. */
                }
              }
              navigate(`/todos/${encodeURIComponent(id)}`, {
                state: {
                  ...location.state,
                  activeProfile,
                  scrollTop: saveScrollPosition(),
                  telosHistory: [],
                  ...(collectionView === 'active' ? {} : { telosCollectionView: collectionView }),
                },
              });
            }}
          />
        </div>
      </div>
    );

  return (
    <div className="todo-page telos-legacy-page">
      <div className="todo-collection-heading">
        <WorkspacePageHeading
          title={collectionView === 'active' ? 'Work' : collectionTitle}
          description="Choose an outcome and take the next step."
          actions={
            <div className="todo-collection-actions">
              {collectionMenu}
              <button
                className="todo-add-btn"
                onClick={() => setCreating({ parentId: undefined })}
                aria-label="Add outcome"
                title="Add todo"
              >
                + Add outcome
              </button>
              <button
                className="todo-refresh"
                onClick={refreshWorkspace}
                aria-label="Refresh Telos"
              >
                <UiIcon name="retry" size={16} />
              </button>
            </div>
          }
        />
      </div>

      <div className="todo-scroll" ref={scrollRef}>
        {planningError && <p role="alert">{planningError}</p>}
        {(canonical.unavailable.length > 0 || discovery.error) && (
          <div role="alert" className="telos-unavailable-records">
            <div className="home-inline-actions">
              <details>
                <summary className="home-text-action">
                  {canonical.unavailable.length > 0
                    ? `${canonical.unavailable.length} records unavailable`
                    : 'Outcome records unavailable'}
                </summary>
                <p>
                  Outcome workspace records unavailable. Original Telos fields remain available
                  below.
                </p>
                {discovery.error && <p>{discovery.error}</p>}
                <ul>
                  {canonical.failures.map((failure) => (
                    <li key={failure.itemId}>
                      {failure.itemId} · {failure.status ? `HTTP ${failure.status} · ` : ''}
                      {failure.code}
                    </li>
                  ))}
                </ul>
              </details>
              <button
                className="home-secondary"
                aria-label="Retry unavailable outcomes"
                onClick={refreshWorkspace}
              >
                Retry
              </button>
            </div>
          </div>
        )}
        <div className="todo-toolbar">
          <label className="todo-search">
            <span aria-hidden="true">
              <UiIcon name="search" size={16} />
            </span>
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
              aria-pressed={activeProfile === undefined}
            >
              All
            </button>
            {profiles.map((p) => (
              <button
                key={p}
                className={`todo-filter-pill${activeProfile === p ? ' todo-filter-pill--active' : ''}`}
                onClick={() => setActiveProfile(activeProfile === p ? undefined : p)}
                aria-pressed={activeProfile === p}
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
          <EmptyState
            icon={<UiIcon name="error" size={24} />}
            title={error}
            subtitle="Tap refresh to try again"
          />
        )}

        {!loading && !error && items.length === 0 && (
          <EmptyState
            icon=<UiIcon name="check" size={16} />
            title="No active items"
            subtitle={
              <>
                Run <code>./mgmt todo --refresh</code> to fetch from sources
              </>
            }
          />
        )}

        {!loading && !error && items.length > 0 && filteredItems.length === 0 && (
          <EmptyState
            icon={<UiIcon name="search" size={24} />}
            title="No matching outcomes"
            subtitle="Try a broader search"
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
                      selectedId={selectedId}
                      onAck={ack}
                      onDone={done}
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
