import { useState, useCallback, useRef } from 'react';
import type { SessionSearchResult } from '../types/chat';
import { apiFetch } from '../lib/api-fetch';

export interface UseSessionSearchReturn {
  query: string;
  setQuery: (q: string) => void;
  results: SessionSearchResult[];
  searching: boolean;
  active: boolean;
  clear: () => void;
}

const DEBOUNCE_MS = 300;

export function useSessionSearch(): UseSessionSearchReturn {
  const [query, setQueryState] = useState('');
  const [results, setResults] = useState<SessionSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const abortRef = useRef<AbortController>(undefined);

  const doSearch = useCallback((q: string) => {
    abortRef.current?.abort();
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
      .then((r) => r.json())
      .then((data) => {
        if (!controller.signal.aborted) {
          setResults(data.results ?? []);
          setSearching(false);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setSearching(false);
      });
  }, []);

  const setQuery = useCallback(
    (q: string) => {
      setQueryState(q);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => doSearch(q), DEBOUNCE_MS);
    },
    [doSearch],
  );

  const clear = useCallback(() => {
    setQueryState('');
    setResults([]);
    setSearching(false);
    abortRef.current?.abort();
    clearTimeout(timerRef.current);
  }, []);

  return {
    query,
    setQuery,
    results,
    searching,
    active: query.trim().length > 0,
    clear,
  };
}
