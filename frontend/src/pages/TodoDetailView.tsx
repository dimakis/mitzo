import { useNavigate, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import type { TodoItem } from '../types/todo';

function sourceIcon(type: string): string {
  switch (type) {
    case 'github':
      return 'GH';
    case 'jira':
      return 'JR';
    case 'gmail':
      return 'GM';
    case 'gdocs':
      return 'GD';
    default:
      return type.slice(0, 2).toUpperCase();
  }
}

function urgencyLabel(urgency: number): string {
  if (urgency >= 0.8) return 'high';
  if (urgency >= 0.5) return 'medium';
  if (urgency >= 0.2) return 'low';
  return 'minimal';
}

function buildPrompt(item: TodoItem): string {
  const hints = item.contextHints;
  const lines: string[] = [`I want to work on this:`, '', `**${item.summary}**`, ''];

  if (item.sources[0]?.url) {
    lines.push(`Source: ${item.sources[0].url}`);
  }
  if (item.sources[0]?.snippet) {
    lines.push('', item.sources[0].snippet);
  }

  const context: string[] = [];
  if (hints.repos.length) context.push(`Repos: ${hints.repos.join(', ')}`);
  if (hints.issues.length) context.push(`Issues: ${hints.issues.join(', ')}`);
  if (hints.paths.length) context.push(`Files: ${hints.paths.join(', ')}`);
  if (hints.jiraKeys.length) context.push(`Jira: ${hints.jiraKeys.join(', ')}`);
  if (hints.keywords.length) context.push(`Keywords: ${hints.keywords.join(', ')}`);

  if (context.length) {
    lines.push('', 'Context:', ...context.map((c) => `- ${c}`));
  }

  if (hints.taskHint) {
    lines.push('', hints.taskHint);
  }

  lines.push('', 'Start by reading the relevant code and giving me a brief assessment.');

  return lines.join('\n');
}

export function TodoDetailView() {
  const navigate = useNavigate();
  const location = useLocation();
  const item = (location.state as { item?: TodoItem } | null)?.item;

  useEffect(() => {
    if (!item) {
      navigate('/todos', { replace: true });
    }
  }, [item, navigate]);

  if (!item) return null;

  const hints = item.contextHints;
  const ageLabel = item.ageDays === 0 ? 'new' : `${item.ageDays}d`;
  const hasContext =
    hints.repos.length > 0 ||
    hints.paths.length > 0 ||
    hints.issues.length > 0 ||
    hints.jiraKeys.length > 0 ||
    hints.keywords.length > 0;

  function handleOpenChat() {
    const prompt = buildPrompt(item!);
    const params = new URLSearchParams();
    params.set('prompt', prompt);
    params.set('extraTools', 'Bash');
    navigate(`/chat?${params.toString()}`);
  }

  function handleSourceClick(url: string) {
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  function handlePathClick(path: string) {
    navigate(`/files?path=${path}`);
  }

  return (
    <div className="todo-detail-page">
      <header className="todo-detail-header">
        <button className="todo-detail-back" onClick={() => navigate('/todos')}>
          &lsaquo;
        </button>
        <h1>Task</h1>
        <button className="todo-detail-chat-btn" onClick={handleOpenChat}>
          Open in Chat
        </button>
      </header>

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

      {item.sources.length > 0 && (
        <section className="todo-detail-sources">
          <h2>Sources</h2>
          {item.sources.map((source, i) => (
            <div
              key={i}
              className="todo-detail-source-row"
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
  );
}
