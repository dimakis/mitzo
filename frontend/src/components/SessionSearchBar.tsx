import { UiIcon } from './UiIcon';
import { SearchMatchText } from './SearchMatchText';
import { useState, useRef, useEffect } from 'react';
import type { SessionSearchResult } from '../types/chat';
import { formatRelativeTime } from '../lib/formatTime';

export interface SessionSearchBarProps {
  query: string;
  setQuery: (q: string) => void;
  results: SessionSearchResult[];
  searching: boolean;
  active: boolean;
  clear: () => void;
  error?: string | null;
  retry?: () => void;
  onSelectSession: (sessionId: string) => void;
}

export function SessionSearchBar({
  query,
  setQuery,
  results,
  searching,
  active,
  clear,
  error,
  retry,
  onSelectSession,
}: SessionSearchBarProps) {
  const [open, setOpen] = useState(active);
  const inputRef = useRef<HTMLInputElement>(null);
  const prevActiveRef = useRef(active);

  useEffect(() => {
    if (active && !prevActiveRef.current) setOpen(true);
    prevActiveRef.current = active;
  }, [active]);

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
    }
  }, [open]);

  function handleClose() {
    setOpen(false);
    clear();
  }

  function handleSelect(sessionId: string) {
    handleClose();
    onSelectSession(sessionId);
  }

  if (!open) {
    return (
      <button
        className="session-search-toggle"
        onClick={() => setOpen(true)}
        title="Search sessions"
      >
        <UiIcon name="search" size={16} />
      </button>
    );
  }

  return (
    <div className="session-search-bar">
      <input
        ref={inputRef}
        className="session-search-input"
        type="text"
        placeholder="Search sessions..."
        aria-label="Search sessions"
        maxLength={512}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') handleClose();
        }}
      />
      <button className="session-search-close" onClick={handleClose} title="Close search">
        <UiIcon name="close" size={16} />
      </button>
      {active && (
        <div className="session-search-results" aria-live="polite">
          {error && (
            <div className="session-search-status" role="alert">
              {error}
              {retry && (
                <button type="button" onClick={retry}>
                  Try again
                </button>
              )}
            </div>
          )}
          {searching && <div className="session-search-status">Searching...</div>}
          {!searching && !error && results.length === 0 && (
            <div className="session-search-status">No matches</div>
          )}
          {!searching &&
            !error &&
            results.map((r) => (
              <button
                key={r.sessionId}
                className="session-search-result"
                onClick={() => handleSelect(r.sessionId)}
              >
                <div className="session-search-result-summary">
                  <SearchMatchText text={r.summary || 'Untitled session'} query={query} />
                </div>
                <div className="session-search-result-snippet">
                  <SearchMatchText text={r.snippet} query={query} />
                </div>
                {!!r.matchedFields?.length && (
                  <div className="conversation-search-evidence">
                    Matches {r.matchedFields.join(' · ')}
                  </div>
                )}
                <div className="session-search-result-meta">
                  <SearchMatchText
                    text={[r.model, r.accountLabel].filter(Boolean).join(' · ')}
                    query={query}
                  />
                </div>
                <div className="session-search-result-meta">
                  <span className="session-search-result-time">
                    {formatRelativeTime(r.updatedAt)}
                  </span>
                </div>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
