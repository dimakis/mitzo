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
  onSelectSession: (sessionId: string) => void;
}

export function SessionSearchBar({
  query,
  setQuery,
  results,
  searching,
  active,
  clear,
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
        ⌕
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
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') handleClose();
        }}
      />
      <button className="session-search-close" onClick={handleClose} title="Close search">
        ✕
      </button>
      {active && (
        <div className="session-search-results">
          {searching && <div className="session-search-status">Searching...</div>}
          {!searching && results.length === 0 && (
            <div className="session-search-status">No matches</div>
          )}
          {!searching &&
            results.map((r) => (
              <button
                key={r.sessionId}
                className="session-search-result"
                onClick={() => handleSelect(r.sessionId)}
              >
                <div className="session-search-result-summary">
                  {r.summary || 'Untitled session'}
                </div>
                <div className="session-search-result-snippet">{r.snippet}</div>
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
