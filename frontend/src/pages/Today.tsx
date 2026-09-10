import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useSessionList } from '../hooks/useSessionList';
import { useAttentionFeed } from '../hooks/useAttentionFeed';
import { formatRelativeTime } from '../lib/formatTime';
import { formatTokens } from '../lib/formatTokens';
import { apiFetch } from '../lib/api-fetch';

const TOKEN_PREFERENCE = 'mitzo-today-tokens';
const BRIEFING_REFRESH_MS = 60_000;
interface Briefing {
  path: string;
  generatedAt: string;
}

function localDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function Today() {
  const navigate = useNavigate();
  const { sessions, loading } = useSessionList();
  const attention = useAttentionFeed();
  const [now, setNow] = useState(() => new Date());
  const [prompt, setPrompt] = useState('');
  const [showTokens, setShowTokens] = useState(
    () => localStorage.getItem(TOKEN_PREFERENCE) === 'true',
  );
  const [briefingResult, setBriefingResult] = useState<Briefing | null>(null);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const today = localDate(now);
  useEffect(() => {
    let cancelled = false;
    const refreshBriefing = () => {
      apiFetch(`/api/briefings/latest?date=${today}`)
        .then((response) => (response.ok ? response.json() : null))
        .then((result: Briefing | null) => {
          if (!cancelled) setBriefingResult(result);
        })
        .catch(() => {
          if (!cancelled) setBriefingResult(null);
        });
    };
    refreshBriefing();
    const timer = window.setInterval(refreshBriefing, BRIEFING_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [today]);
  const hour = now.getHours();
  const period =
    hour >= 5 && hour < 12 ? 'morning' : hour >= 12 && hour < 18 ? 'afternoon' : 'evening';
  const heading =
    period === 'morning'
      ? 'Start with what matters.'
      : period === 'afternoon'
        ? 'Make room for what matters.'
        : 'A little clarity for tomorrow.';
  // TELOS age-derived urgency alone is not a reason to put a record in focus.
  const focus = attention.items
    .filter((item) => item.source !== 'telos' || item.pinned)
    .slice(0, 3);
  const recent = [...sessions].sort((a, b) => b.lastModified - a.lastModified).slice(0, 2);
  const briefing = new URLSearchParams({
    prompt: `Prepare my ${period} briefing — review calendar, email highlights and Jira. Distinguish unavailable sources from no changes.`,
  });
  return (
    <main className="workspace-page today-page">
      <header className="today-top">
        <Link to="/" className="workspace-brand">
          Mitzo<span aria-hidden="true">.</span>
        </Link>
        <Link to="/sessions">Search chats</Link>
      </header>
      <div className="today-heading">
        <p className="workspace-eyebrow">
          {now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
        </p>
        <h1>{heading}</h1>
        <p className="workspace-muted">A clear place to pick up your day.</p>
      </div>
      <div className="today-grid">
        <div>
          <section className="today-brief" aria-labelledby="brief-title">
            <p className="workspace-eyebrow">Your {period}</p>
            <h2 id="brief-title">Get your bearings</h2>
            <p>Review changes across calendar, email and Jira.</p>
            <p className="workspace-muted">
              {briefingResult
                ? `Briefing prepared at ${new Date(briefingResult.generatedAt).toLocaleTimeString(
                    [],
                    {
                      hour: '2-digit',
                      minute: '2-digit',
                    },
                  )}.`
                : 'Sources haven’t been checked here yet.'}
            </p>
            <div className="workspace-actions">
              {briefingResult ? (
                <Link
                  className="workspace-primary"
                  to={`/files?${new URLSearchParams({ path: briefingResult.path, from: '/' })}`}
                >
                  Open briefing
                </Link>
              ) : (
                <Link className="workspace-primary" to={`/chat?${briefing}`}>
                  Prepare my briefing
                </Link>
              )}
              {briefingResult && <Link to={`/chat?${briefing}`}>Prepare another</Link>}
              <Link to="/calendar">Open calendar</Link>
            </div>
          </section>
          <section aria-labelledby="focus-title" className="today-section">
            <div className="workspace-section-heading">
              <h2 id="focus-title">Your focus</h2>
              <Link to="/focus">View attention</Link>
            </div>
            {attention.loading ? (
              <p role="status">Loading focus…</p>
            ) : focus.length === 0 ? (
              <p className="workspace-muted">
                No focus items to show. Choose your next step in <Link to="/todos">Work</Link>.
              </p>
            ) : (
              focus.map((item) => (
                <Link className="workspace-record" key={item.id} to={item.navigateTo}>
                  <span>
                    <strong>{item.title}</strong>
                    <small>
                      {item.pinned
                        ? 'Pinned in TELOS'
                        : item.source === 'atb'
                          ? 'Agent work'
                          : 'Session'}{' '}
                      · {item.meta}
                    </small>
                  </span>
                  <span aria-hidden="true">↗</span>
                </Link>
              ))
            )}
            <Link className="workspace-text-link" to="/todos">
              All work →
            </Link>
          </section>
        </div>
        <section className="today-section today-recent" aria-labelledby="recent-title">
          <div className="workspace-section-heading">
            <h2 id="recent-title">Pick up where you left off</h2>
          </div>
          {loading ? (
            <p role="status">Loading recent chats…</p>
          ) : recent.length === 0 ? (
            <p className="workspace-muted">Your conversations will appear here.</p>
          ) : (
            recent.map((session) => (
              <Link className="workspace-record" key={session.id} to={`/chat/${session.id}`}>
                <span>
                  <strong>{session.summary || 'Untitled session'}</strong>
                  <small>
                    {session.isActive ? 'Active · ' : ''}
                    {formatRelativeTime(session.lastModified)}
                  </small>
                  {showTokens && session.totalTokens != null && (
                    <small className="workspace-tokens">
                      {formatTokens(session.totalTokens)} tokens · session
                    </small>
                  )}
                </span>
                <span aria-hidden="true">↗</span>
              </Link>
            ))
          )}
          <Link className="workspace-text-link" to="/sessions">
            All chats →
          </Link>
          <label className="today-token-toggle">
            <input
              type="checkbox"
              checked={showTokens}
              onChange={(event) => {
                setShowTokens(event.target.checked);
                localStorage.setItem(TOKEN_PREFERENCE, String(event.target.checked));
              }}
            />
            Show session tokens on Today
          </label>
        </section>
      </div>
      <form
        className="today-composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (prompt.trim()) navigate(`/chat?${new URLSearchParams({ prompt: prompt.trim() })}`);
        }}
      >
        <label htmlFor="today-prompt" className="workspace-eyebrow">
          Ask Mitzo
        </label>
        <div>
          <input
            id="today-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="What would you like to move forward?"
          />
          <button
            type="submit"
            className="workspace-primary"
            disabled={!prompt.trim()}
            aria-label="Start chat"
          >
            Send ↗
          </button>
        </div>
        <Link to="/chat">Open a new chat</Link>
      </form>
    </main>
  );
}
