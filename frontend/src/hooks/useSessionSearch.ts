import { useState, useCallback, useRef, useEffect } from 'react';
import type { SessionSearchResult } from '../types/chat';
import { apiFetch } from '../lib/api-fetch';
import { eventBus } from '../lib/event-bus-singleton';

export interface UseSessionSearchReturn {
  query: string;
  setQuery: (q: string) => void;
  results: SessionSearchResult[];
  searching: boolean;
  active: boolean;
  error: string | null;
  retry: () => void;
  clear: () => void;
}

const DEBOUNCE_MS = 300;

export function useSessionSearch(): UseSessionSearchReturn {
  const [query, setQueryState] = useState('');
  const [results, setResults] = useState<SessionSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const abortRef = useRef<AbortController>(undefined);

  const doSearch = useCallback((q: string) => {
    abortRef.current?.abort();
    setError(null);
    if (!q.trim()) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const controller = new AbortController();
    abortRef.current = controller;
    apiFetch(`/api/sessions/search?q=${encodeURIComponent(q)}`, {
      signal: controller.signal,
    })
      .then((r) => {
        if (!r.ok) throw new Error('Search unavailable');
        return r.json();
      })
      .then((data) => {
        if (!controller.signal.aborted) {
          if (!Array.isArray(data.results)) throw new Error('Invalid search results');
          setResults(data.results);
          setSearching(false);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setResults([]);
          setError('Couldn’t search sessions. Try again.');
          setSearching(false);
        }
      });
  }, []);

  const setQuery = useCallback(
    (q: string) => {
      setQueryState(q);
      abortRef.current?.abort();
      setResults([]);
      setError(null);
      setSearching(Boolean(q.trim()));
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => doSearch(q), DEBOUNCE_MS);
    },
    [doSearch],
  );

  useEffect(() => {
    return () => {
      clearTimeout(timerRef.current);
      abortRef.current?.abort();
    };
  }, []);

  useEffect(
    () =>
      eventBus.on('sessions_changed', () => {
        if (!query.trim()) return;
        clearTimeout(timerRef.current);
        doSearch(query);
      }),
    [doSearch, query],
  );

  const clear = useCallback(() => {
    setQueryState('');
    setResults([]);
    setSearching(false);
    setError(null);
    abortRef.current?.abort();
    clearTimeout(timerRef.current);
  }, []);

  const retry = useCallback(() => {
    clearTimeout(timerRef.current);
    doSearch(query);
  }, [doSearch, query]);

  return {
    query,
    setQuery,
    results,
    searching,
    active: query.trim().length > 0,
    error,
    retry,
    clear,
  };
}
