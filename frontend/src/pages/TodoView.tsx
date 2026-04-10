import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { TodoCard } from '../components/TodoCard';
import { useTodoData } from '../hooks/useTodoData';
import type { TodoItem } from '../types/todo';

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

export function TodoView() {
  const navigate = useNavigate();
  const [activeProfile, setActiveProfile] = useState<string | undefined>(undefined);
  const { loading, items, profiles, ack, done, refresh } = useTodoData(activeProfile);

  function handleTap(item: TodoItem) {
    const prompt = buildPrompt(item);
    const params = new URLSearchParams();
    params.set('prompt', prompt);
    params.set('extraTools', 'Bash');
    navigate(`/chat?${params.toString()}`);
  }

  return (
    <div className="todo-page">
      <header className="todo-header">
        <button className="todo-back" onClick={() => navigate('/')}>
          &lsaquo;
        </button>
        <h1>Todos {items.length > 0 && <span className="todo-count">{items.length}</span>}</h1>
        <button className="todo-refresh" onClick={refresh}>
          &#x21bb;
        </button>
      </header>

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

      {loading && <p className="todo-empty">Loading...</p>}

      {!loading && items.length === 0 && (
        <div className="todo-empty">
          <div className="todo-empty-icon">&#10003;</div>
          <p>No active items</p>
          <p className="todo-empty-hint">
            Run <code>./mgmt todo --refresh</code> to fetch from sources
          </p>
        </div>
      )}

      <div className="todo-hint">
        {items.length > 0 && <span>Tap to start working. Swipe right = seen, left = done.</span>}
      </div>

      <div className="todo-list">
        {items.map((item) => (
          <TodoCard key={item.id} item={item} onAck={ack} onDone={done} onTap={handleTap} />
        ))}
      </div>
    </div>
  );
}
