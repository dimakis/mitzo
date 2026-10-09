import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSessionList } from '../hooks/useSessionList';
import { useSessionSearch } from '../hooks/useSessionSearch';
import { useHomePreferences } from '../hooks/useHomePreferences';
import { HomePins } from '../components/HomePins';
import { DailyQuoteLink } from '../components/DailyQuoteLink';
import { recordTitle } from '../lib/record-title';
import '../styles/home.css';
import { formatRelativeTime } from '../lib/formatTime';
import { formatTokens } from '../lib/formatTokens';
import { apiFetch } from '../lib/api-fetch';
import { WorkspacePageHeading } from '../components/WorkspacePageHeading';

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
  const { sessions, loading, error: sessionsError, retry: retrySessions } = useSessionList();
  const search = useSessionSearch();
  const home = useHomePreferences();
  const [now, setNow] = useState(() => new Date());
  const [showTokens, setShowTokens] = useState(
    () => localStorage.getItem(TOKEN_PREFERENCE) === 'true',
  );
  const [briefingState, setBriefing] = useState<{ date: string; result: Briefing | null }>(() => ({
    date: localDate(new Date()),
    result: null,
  }));
  const briefingRequest = useRef(0);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const today = localDate(now);
  const briefingResult = briefingState.date === today ? briefingState.result : null;
  useEffect(() => {
    let cancelled = false;
    setBriefing({ date: today, result: null });
    const refreshBriefing = () => {
      const request = ++briefingRequest.current;
      apiFetch(`/api/briefings/latest?date=${today}`)
        .then((response) => (response.ok ? response.json() : null))
        .then((result: Briefing | null) => {
          if (!cancelled && request === briefingRequest.current)
            setBriefing({ date: today, result });
        })
        .catch(() => {
          if (!cancelled && request === briefingRequest.current)
            setBriefing({ date: today, result: null });
        });
    };
    refreshBriefing();
    const timer = window.setInterval(refreshBriefing, BRIEFING_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [today]);
  const recent = [...sessions].sort((a, b) => b.lastModified - a.lastModified).slice(0, 3);
  return (
    <main className="workspace-page today-page">
      <WorkspacePageHeading
        className="today-heading"
        eyebrow={now.toLocaleDateString(undefined, {
          weekday: 'long',
          month: 'long',
          day: 'numeric',
        })}
        title="Today"
        titleAccessory={<DailyQuoteLink date={today} />}
        actions={
          <Link className="home-secondary" to="/chat">
            New session <span aria-hidden="true">＋</span>
          </Link>
        }
      />
      <label className="home-search today-search">
        Search sessions and messages
        <input
          type="search"
          value={search.query}
          onChange={(event) => search.setQuery(event.target.value)}
          placeholder="Find a conversation or something you said…"
        />
      </label>
      {search.active ? (
        <section className="today-section" aria-labelledby="today-search-title">
          <h2 id="today-search-title">Search results</h2>
          {search.searching ? (
            <p role="status">Searching…</p>
          ) : search.error ? (
            <div className="workspace-load-error" role="alert">
              <span>{search.error}</span>
              <button type="button" onClick={search.retry}>
                Try again
              </button>
            </div>
          ) : search.results.length ? (
            search.results.map((result) => (
              <Link
                className="workspace-record home-record"
                key={result.sessionId}
                to={`/chat/${encodeURIComponent(result.sessionId)}`}
              >
                <span>
                  <strong>{recordTitle(result.summary || 'Untitled session')}</strong>
                  <small>{result.snippet}</small>
                </span>
                <span aria-hidden="true">↗</span>
              </Link>
            ))
          ) : (
            <p className="workspace-muted">No matching sessions or messages.</p>
          )}
        </section>
      ) : (
        <div className="today-home-grid">
          <div>
            <HomePins sessions={sessions} />
            <section className="today-section" aria-labelledby="recent-title">
              <div className="workspace-section-heading">
                <h2 id="recent-title">Recent sessions</h2>
                <Link to="/sessions">All sessions</Link>
              </div>
              {loading ? (
                <p role="status">Loading recent chats…</p>
              ) : sessionsError ? (
                <div className="workspace-load-error" role="alert">
                  <span>{sessionsError}</span>
                  <button type="button" onClick={retrySessions}>
                    Try again
                  </button>
                </div>
              ) : recent.length === 0 ? (
                <p className="workspace-muted">Your conversations will appear here.</p>
              ) : (
                recent.map((session) => (
                  <Link
                    className="workspace-record home-record"
                    key={session.id}
                    to={`/chat/${encodeURIComponent(session.id)}`}
                  >
                    <span>
                      <strong>{recordTitle(session.summary || 'Untitled session')}</strong>
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
          <section className="today-brief home-brief" aria-labelledby="brief-title">
            <p className="workspace-eyebrow">Your saved daily brief</p>
            <h2 id="brief-title">Morning briefing</h2>
            <p>Calendar updates, meeting context and the details worth a closer look.</p>
            <p className="workspace-muted">
              {briefingResult
                ? `Briefing prepared at ${new Date(briefingResult.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
                : 'No saved briefing for today yet.'}
            </p>
            <div className="workspace-actions">
              {briefingResult && (
                <>
                  <Link className="home-secondary" to={`/briefings/${today}`}>
                    Read briefing
                  </Link>
                  <Link className="workspace-text-link" to={`/briefings/${today}?ask=1`}>
                    Ask {home.preferences?.names.briefing || 'Minion'}
                  </Link>
                </>
              )}
              <Link className="workspace-text-link" to="/calendar">
                Open calendar
              </Link>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
