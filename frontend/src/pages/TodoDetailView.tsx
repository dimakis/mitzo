import { useNavigate, useLocation, useParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import type { TodoItem, TodoData } from '../types/todo';
import { sourceIcon, buildPrompt } from '../lib/todo-utils';
import { PageHeader } from '../components/PageHeader';
import { apiFetch } from '../lib/api-fetch';

function urgencyLabel(urgency: number): string {
  if (urgency >= 0.8) return 'high';
  if (urgency >= 0.5) return 'medium';
  if (urgency >= 0.2) return 'low';
  return 'minimal';
}

function findInTree(items: TodoItem[], id: string): TodoItem | undefined {
  for (const item of items) {
    if (item.id === id) return item;
    const found = findInTree(item.children, id);
    if (found) return found;
  }
  return undefined;
}

export function TodoDetailView() {
  const navigate = useNavigate();
  const location = useLocation();
  const { id } = useParams<{ id: string }>();
  const stateItem = (location.state as { item?: TodoItem } | null)?.item;
  const [fetchedItem, setFetchedItem] = useState<TodoItem | null>(null);
  const [fetchFailed, setFetchFailed] = useState(false);

  useEffect(() => {
    if (stateItem || !id) return;

    const controller = new AbortController();

    apiFetch('/api/todos', { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((data: TodoData) => {
        const found = findInTree(data.items, id);
        if (found) {
          setFetchedItem(found);
        } else {
          setFetchFailed(true);
        }
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setFetchFailed(true);
      });

    return () => controller.abort();
  }, [stateItem, id]);

  const item = stateItem ?? fetchedItem;

  useEffect(() => {
    if (fetchFailed) {
      navigate('/todos', { replace: true });
    }
  }, [fetchFailed, navigate]);

  if (!item) {
    if (fetchFailed) return null;
    return <div className="todo-detail-page">Loading...</div>;
  }

  // Capture narrowed item for use in nested functions (TS doesn't narrow across closures)
  const currentItem: TodoItem = item;
  const hints = currentItem.contextHints;
  const ageLabel = item.ageDays === 0 ? 'new' : `${item.ageDays}d`;
  const hasContext =
    hints.repos.length > 0 ||
    hints.paths.length > 0 ||
    hints.issues.length > 0 ||
    hints.jiraKeys.length > 0 ||
    hints.keywords.length > 0;

  function handleOpenChat() {
    const prompt = buildPrompt(currentItem);
    const params = new URLSearchParams();
    params.set('prompt', prompt);
    params.set('extraTools', 'Bash');
    navigate(`/chat?${params.toString()}`);
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

  return (
    <div className="todo-detail-page">
      <PageHeader title="Task" onBack={handleBack}>
        <button className="todo-detail-chat-btn" onClick={handleOpenChat}>
          Open in Chat
        </button>
      </PageHeader>

      <div className="todo-detail-scroll">
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
        </div>

        {item.children.length > 0 && (
          <section className="todo-detail-children">
            <h2>
              Sub-tasks{' '}
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
                <span className="todo-detail-child-status">
                  {child.status === 'completed' ? '\u2713' : '\u25cb'}
                </span>
                <span className="todo-detail-child-summary">{child.summary}</span>
              </div>
            ))}
          </section>
        )}

        {item.sources.length > 0 && (
          <section className="todo-detail-sources">
            <h2>Sources</h2>
            {item.sources.map((source, i) => (
              <div
                key={i}
                className={`todo-detail-source-row${source.url ? '' : ' todo-detail-source-row--no-link'}`}
                onClick={() => source.url && handleSourceClick(source.url)}
              >
                <span className="todo-detail-source-badge">{sourceIcon(source.type)}</span>
                <div className="todo-detail-source-content">
                  <div className="todo-detail-source-title">{source.title}</div>
                  <div className="todo-detail-source-author">{source.author}</div>
                  {source.snippet && (
                    <div className="todo-detail-source-snippet">{source.snippet}</div>
                  )}
                </div>
              </div>
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
