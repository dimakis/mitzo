import { TelosItemWorkspace } from '../components/TelosItemWorkspace';
import { useTelosRecords } from '../hooks/useTelosRecords';
import { TelosItemSources } from '../components/TelosItemSources';
import { TelosItemRoleEntries } from '../components/TelosItemRoleEntries';
import { useStageChatLaunch } from '../hooks/useStageChatLaunch';
import { UiIcon } from '../components/UiIcon';
import { useNavigate, useLocation, useParams } from 'react-router-dom';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { findInTree, useTodoData, useLatestTodoPriority } from '../hooks/useTodoData';
import { TodoPrioritySelect } from '../components/TodoPrioritySelect';
import { createTodoPrioritySaveState } from '../lib/todo-priority-save-state';
import type { TodoItem } from '../types/todo';
import { sourceIcon, buildPrompt, buildTodoContext, todoPriority } from '../lib/todo-utils';
import { WorkOutputs } from '../components/WorkOutputs';
import { PageHeader } from '../components/PageHeader';
import { apiFetch } from '../lib/api-fetch';
import { shareTelosArtifact } from '../lib/share-file';
import { HomePinButton } from '../components/HomePinButton';
import { recordTitle } from '../lib/record-title';
import { parseItemHistory, readTelosItemHistory } from '../lib/telos-item-navigation';

function urgencyLabel(urgency: number): string {
  if (urgency >= 0.8) return 'high';
  if (urgency >= 0.5) return 'medium';
  if (urgency >= 0.2) return 'low';
  return 'minimal';
}

export function TodoDetailView() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const prioritySaveState = useMemo(() => createTodoPrioritySaveState(id), [id]);
  const {
    items,
    loading,
    refreshing,
    error,
    refresh,
    setPriority: updatePriority,
  } = useTodoData(undefined, id);
  const setPendingSession = useStageChatLaunch();
  const location = useLocation();
  const historyKey = 'telos.item.history.' + id;
  const navigationHistory = (location.state as { telosHistory?: unknown } | null)?.telosHistory;
  // Artifact selectors and Files own URL navigation; S7 owns its item trail.
  useEffect(() => {
    if (navigationHistory === undefined) return;
    try {
      sessionStorage.setItem(historyKey, JSON.stringify(parseItemHistory(navigationHistory)));
    } catch {
      /* Navigation remains available when device preferences are unavailable. */
    }
  }, [historyKey, navigationHistory]);
  function itemHistory() {
    return readTelosItemHistory(id ?? '', navigationHistory);
  }

  const navigationItem = (location.state as { item?: TodoItem } | null)?.item;
  const [stateItem, setStateItem] = useState(navigationItem);
  useEffect(() => setStateItem(navigationItem), [navigationItem]);
  const fallbackItem = useLatestTodoPriority(stateItem?.id === id ? stateItem : undefined);
  const [promoting, setPromoting] = useState(false);
  const [promoteError, setPromoteError] = useState<string | null>(null);
  const [ordinaryRoleItem, setOrdinaryRoleItem] = useState<string | null>(null);
  const onOrdinaryRoles = useCallback((itemId: string, available: boolean) => {
    setOrdinaryRoleItem(available ? itemId : null);
  }, []);

  const item = (id ? findInTree(items, id) : undefined) ?? fallbackItem;

  const recordIds = id ? [id] : [];
  function collectRecordIds(value: TodoItem) {
    for (const child of value.children) {
      recordIds.push(child.id);
      collectRecordIds(child);
    }
  }
  if (item) {
    collectRecordIds(item);
    if (item.parentId) recordIds.push(item.parentId);
  }
  // Collection discovery changes parent/child membership, not the current
  // workspace's lifetime. Keep its accepted read keyed only to the route item.
  const primary = useTelosRecords(id ? [id] : []);
  const related = useTelosRecords(
    recordIds.filter((value) => value !== id),
    primary.refreshKey,
  );
  const canonical = {
    records: [...primary.records, ...related.records],
    unavailable: [...primary.unavailable, ...related.unavailable],
    loading: primary.loading,
    refreshKey: related.refreshKey,
    refresh: primary.refresh,
  };
  const record = primary.records.find((value) => value.itemId === id);

  useEffect(() => {
    if (!loading && !refreshing && !error && !item && !canonical.loading && !record)
      navigate('/todos', { replace: true });
  }, [loading, refreshing, error, item, navigate, canonical.loading, record]);

  if (record)
    return (
      <div className="todo-detail-page telos-canonical-page">
        <div className="todo-detail-scroll">
          {canonical.unavailable.length > 0 && (
            <p role="alert">
              Some related outcome records are unavailable.{' '}
              <button onClick={canonical.refresh}>Try again</button>
            </p>
          )}
          <TelosItemWorkspace
            key={record.itemId}
            record={record}
            prioritySaveState={prioritySaveState}
            refreshKey={canonical.refreshKey}
            relatedState={
              error
                ? 'unavailable'
                : !item || related.loading
                  ? 'loading'
                  : canonical.unavailable.some(
                        (value) => value !== record.itemId && value !== record.parentId,
                      )
                    ? 'unavailable'
                    : 'ready'
            }
            onRefresh={() => {
              refresh();
              canonical.refresh();
            }}
            records={canonical.records}
            onBack={() => {
              const history = itemHistory();
              navigate(
                history.length
                  ? `/todos/${encodeURIComponent(history[history.length - 1])}`
                  : '/todos',
                { state: { ...location.state, telosHistory: history.slice(0, -1) } },
              );
            }}
            onOpen={(itemId, view) => {
              if (view) {
                try {
                  sessionStorage.setItem('telos.item.tab.' + itemId, view);
                } catch {
                  /* Preferences are optional. */
                }
              }
              navigate(`/todos/${encodeURIComponent(itemId)}`, {
                state: {
                  ...location.state,
                  item: undefined,
                  telosHistory: [...itemHistory(), record.itemId],
                },
              });
            }}
          />
        </div>
      </div>
    );

  if (!item) {
    if (error)
      return (
        <div className="todo-detail-page" role="alert">
          {error} <button onClick={refresh}>Retry</button>
        </div>
      );
    return <div className="todo-detail-page">Loading...</div>;
  }

  // Capture narrowed item for use in nested functions (TS doesn't narrow across closures)
  const currentItem: TodoItem = item;
  async function handlePriority(priority: number) {
    await updatePriority(currentItem.id, priority);
    // The navigation snapshot can still be displayed after a failed list read.
    // Retain acknowledged edits there until canonical list data is available.
    setStateItem((previous) =>
      previous?.id === currentItem.id ? { ...previous, priority } : previous,
    );
  }
  const hints = currentItem.contextHints;
  const ageLabel = item.ageDays === 0 ? 'new' : `${item.ageDays}d`;
  const hasContext =
    hints.repos.length > 0 ||
    hints.paths.length > 0 ||
    hints.issues.length > 0 ||
    hints.docIds.length > 0 ||
    hints.people.length > 0 ||
    hints.jiraKeys.length > 0 ||
    hints.keywords.length > 0 ||
    (hints.sessionIds?.length ?? 0) > 0;

  function handleOpenChat() {
    const prompt = buildPrompt(currentItem);
    setPendingSession(
      {
        prompt,
        context: buildTodoContext(currentItem),
        telosTaskId: currentItem.id,
        agentName: 'mitzo-telos',
      },
      'extraTools=Bash',
    );
  }

  function handleBack() {
    const state = location.state as { activeProfile?: string; scrollTop?: number } | null;
    navigate('/todos', {
      state: { activeProfile: state?.activeProfile, scrollTop: state?.scrollTop },
    });
  }

  function handleSourceClick(url: string) {
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  function handlePathClick(path: string) {
    const params = new URLSearchParams();
    params.set('path', path);
    navigate(`/files?${params.toString()}`);
  }

  function handleLinkClick(url: string) {
    if (/^\/api\/telos\/artifacts\/[a-f0-9]{32}(?:\?revision=[1-9]\d*)?$/.test(url)) {
      setPromoteError(null);
      void shareTelosArtifact(url).catch((error: unknown) => {
        setPromoteError(error instanceof Error ? error.message : 'Artifact download failed');
      });
    } else if (/^https?:\/\//i.test(url)) {
      handleSourceClick(url);
    } else {
      handlePathClick(url);
    }
  }

  async function handlePromote() {
    if (!currentItem || promoting) return;

    setPromoting(true);
    setPromoteError(null);

    try {
      const res = await apiFetch(`/api/workload/items/${currentItem.id}/promote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: '',
          title: currentItem.summary,
          contextHints: currentItem.contextHints,
          sources: currentItem.sources,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
      }

      const result = await res.json();
      navigate(`/tasks?highlight=${result.task.id}`);
    } catch (err) {
      setPromoteError(err instanceof Error ? err.message : 'Failed to promote');
    } finally {
      setPromoting(false);
    }
  }

  return (
    <div className="todo-detail-page">
      <PageHeader title="Task" onBack={handleBack}>
        <div className="todo-detail-actions">
          <TodoPrioritySelect
            key={item.id}
            saveState={prioritySaveState}
            priority={todoPriority(item)}
            onChange={handlePriority}
          />
          <HomePinButton pin={{ kind: 'telos', id: item.id, title: recordTitle(item.summary) }} />
          {ordinaryRoleItem !== item.id && (
            <button className="todo-detail-chat-btn" onClick={handleOpenChat}>
              Open in Chat
            </button>
          )}
          {!item.goalId && (
            <button
              className="todo-detail-promote-btn"
              onClick={handlePromote}
              disabled={promoting}
            >
              {promoting ? 'Promoting...' : 'Promote to Tasks'}
            </button>
          )}
        </div>
      </PageHeader>
      {promoteError && <div className="todo-detail-error">{promoteError}</div>}

      <div className="todo-detail-scroll">
        {canonical.unavailable.includes(item.id) && (
          <p role="alert">Outcome workspace unavailable. Showing original Telos fields.</p>
        )}
        <div className="todo-detail-summary">{item.summary}</div>

        <div className="todo-detail-meta">
          <span className={`todo-detail-status todo-detail-status--${item.status}`}>
            {item.status}
          </span>
          <span className="todo-detail-urgency" title={`Urgency: ${item.urgency.toFixed(2)}`}>
            {urgencyLabel(item.urgency)}
          </span>
          <span className="todo-detail-age">{ageLabel}</span>
          <span className="todo-detail-profile">{item.profile}</span>
          {item.goalId && (
            <span
              className="todo-detail-promoted"
              onClick={() => navigate(`/tasks?highlight=${item.goalId}`)}
              title="Click to view task"
            >
              <UiIcon name="forward" size={16} /> Task Board
            </span>
          )}
        </div>

        <TelosItemRoleEntries key={item.id} itemId={item.id} onOrdinaryRoles={onOrdinaryRoles} />

        {item.intent && (
          <section className="todo-detail-contract todo-detail-outcome">
            <h2>Outcome</h2>
            <p>{item.intent}</p>
          </section>
        )}

        {item.rationale && (
          <section className="todo-detail-contract">
            <h2>Why this matters</h2>
            <p>{item.rationale}</p>
          </section>
        )}

        {(item.acceptanceCriteria?.length ?? 0) > 0 && (
          <section className="todo-detail-contract">
            <h2>Done when</h2>
            <ul className="todo-detail-criteria">
              {item.acceptanceCriteria?.map((criterion) => (
                <li key={criterion}>{criterion}</li>
              ))}
            </ul>
          </section>
        )}

        <WorkOutputs key={'outputs:' + item.id} itemId={item.id} profile={item.profile} />

        {item.children.length > 0 && (
          <section className="todo-detail-children">
            <h2>
              Milestones{' '}
              <span className="todo-detail-children-count">
                {item.completedChildCount}/{item.childCount}
              </span>
            </h2>
            {item.children.map((child) => (
              <div
                key={child.id}
                className={`todo-detail-child-row${child.status === 'completed' ? ' todo-detail-child-row--done' : ''}`}
                onClick={() => {
                  const state = location.state as {
                    activeProfile?: string;
                    scrollTop?: number;
                  } | null;
                  navigate(`/todos/${child.id}`, {
                    state: {
                      item: child,
                      activeProfile: state?.activeProfile,
                      scrollTop: state?.scrollTop,
                    },
                  });
                }}
              >
                <span
                  className="todo-detail-child-status"
                  role="img"
                  aria-label={`Status: ${child.status}`}
                >
                  <UiIcon name={child.status === 'completed' ? 'complete' : 'circle'} size={16} />
                </span>
                <span className="todo-detail-child-summary">{child.summary}</span>
              </div>
            ))}
          </section>
        )}

        <TelosItemSources
          itemId={item.id}
          legacySources={item.sources}
          onOpenExternal={handleSourceClick}
        />

        {(item.links?.length ?? 0) > 0 && (
          <section className="todo-detail-links">
            <h2>Links</h2>
            {item.links?.map((link) => (
              <button
                key={`${link.type}:${link.url}`}
                type="button"
                className="todo-detail-source-row todo-detail-link-row"
                onClick={() => handleLinkClick(link.url)}
              >
                <span className="todo-detail-source-badge">{sourceIcon(link.type)}</span>
                <div className="todo-detail-source-content">
                  <div className="todo-detail-source-title">{link.title}</div>
                  {link.description && (
                    <div className="todo-detail-source-snippet">{link.description}</div>
                  )}
                </div>
              </button>
            ))}
          </section>
        )}

        {hints.taskHint && (
          <section className="todo-detail-task-hint">
            <h2>Task Hint</h2>
            <p>{hints.taskHint}</p>
          </section>
        )}

        {hasContext && (
          <section className="todo-detail-context">
            <h2>Context</h2>

            {hints.paths.length > 0 && (
              <div className="todo-detail-context-group">
                <h3>Files</h3>
                <div className="todo-detail-chips">
                  {hints.paths.map((path) => (
                    <button
                      key={path}
                      className="todo-detail-chip todo-detail-chip--path"
                      onClick={() => handlePathClick(path)}
                    >
                      {path}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {hints.repos.length > 0 && (
              <div className="todo-detail-context-group">
                <h3>Repos</h3>
                <div className="todo-detail-chips">
                  {hints.repos.map((repo) => (
                    <span key={repo} className="todo-detail-chip">
                      {repo}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {hints.issues.length > 0 && (
              <div className="todo-detail-context-group">
                <h3>Issues</h3>
                <div className="todo-detail-chips">
                  {hints.issues.map((issue) => (
                    <span key={issue} className="todo-detail-chip">
                      {issue}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {hints.docIds.length > 0 && (
              <div className="todo-detail-context-group">
                <h3>Documents</h3>
                <div className="todo-detail-chips">
                  {hints.docIds.map((docId) => (
                    <span key={docId} className="todo-detail-chip">
                      {docId}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {hints.people.length > 0 && (
              <div className="todo-detail-context-group">
                <h3>People</h3>
                <div className="todo-detail-chips">
                  {hints.people.map((person) => (
                    <span key={person} className="todo-detail-chip">
                      {person}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {hints.jiraKeys.length > 0 && (
              <div className="todo-detail-context-group">
                <h3>Jira</h3>
                <div className="todo-detail-chips">
                  {hints.jiraKeys.map((key) => (
                    <span key={key} className="todo-detail-chip">
                      {key}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {hints.keywords.length > 0 && (
              <div className="todo-detail-context-group">
                <h3>Keywords</h3>
                <div className="todo-detail-chips">
                  {hints.keywords.map((kw) => (
                    <span key={kw} className="todo-detail-chip">
                      {kw}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
