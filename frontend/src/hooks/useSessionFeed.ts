import { useState, useEffect, useMemo, useCallback } from 'react';
import { eventBus } from '../lib/event-bus-singleton';
import type { SessionActivity } from '@mitzo/protocol';

export type FeedFilter = 'all' | 'needs_me' | 'in_progress' | 'done';

export interface UseSessionFeedReturn {
  /** Filtered + sorted sessions for the current chip. */
  items: SessionActivity[];
  /** Counts per filter chip (computed from full working batch). */
  counts: { all: number; needsMe: number; inProgress: number; done: number };
  /** Currently selected filter. */
  filter: FeedFilter;
  /** Change the active filter. */
  setFilter: (f: FeedFilter) => void;
  /** Whether SSE is connected. */
  connected: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const STORAGE_KEY = 'mitzo:feedFilter';
const WORKING_BATCH_HOURS = 48;
const WORKING_BATCH_MS = WORKING_BATCH_HOURS * 60 * 60 * 1000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isInWorkingBatch(a: SessionActivity, now: number): boolean {
  // Active/live states always in batch
  if (a.state === 'working' || a.state === 'waiting') return true;
  // Awaiting reply or uncommitted work — always relevant
  if (a.awaitingReply || a.uncommittedWork) return true;
  // Done sessions within the time window
  if (a.state === 'done' && now - a.lastEventAt < WORKING_BATCH_MS) return true;
  // Everything else (idle, init, paused, old done) excluded
  return false;
}

function needsMe(a: SessionActivity): boolean {
  return !!(a.awaitingReply || a.state === 'waiting' || a.uncommittedWork);
}

function matchesFilter(a: SessionActivity, filter: FeedFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'needs_me':
      return needsMe(a);
    case 'in_progress':
      return a.state === 'working';
    case 'done':
      return a.state === 'done';
  }
}

function loadSavedFilter(): FeedFilter {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'all' || saved === 'needs_me' || saved === 'in_progress' || saved === 'done') {
      return saved;
    }
  } catch {
    // localStorage unavailable
  }
  return 'needs_me';
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useSessionFeed(): UseSessionFeedReturn {
  const [activities, setActivities] = useState<SessionActivity[]>([]);
  const [connected, setConnected] = useState(eventBus.connected);
  const [filter, setFilterState] = useState<FeedFilter>(loadSavedFilter);

  const setFilter = useCallback((f: FeedFilter) => {
    setFilterState(f);
    try {
      localStorage.setItem(STORAGE_KEY, f);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    const unsubActivity = eventBus.on('session_activity', (data) => {
      setActivities(data as SessionActivity[]);
    });
    const unsubConnection = eventBus.onConnectionChange((c) => setConnected(c));
    return () => {
      unsubActivity();
      unsubConnection();
    };
  }, []);

  // Working batch: all sessions in the user's current active set
  const workingBatch = useMemo(() => {
    const now = Date.now();
    return activities.filter((a) => isInWorkingBatch(a, now));
  }, [activities]);

  // Counts for chip badges
  const counts = useMemo(
    () => ({
      all: workingBatch.length,
      needsMe: workingBatch.filter(needsMe).length,
      inProgress: workingBatch.filter((a) => a.state === 'working').length,
      done: workingBatch.filter((a) => a.state === 'done').length,
    }),
    [workingBatch],
  );

  // Filtered + sorted (oldest first = longest waiting gets attention first)
  const items = useMemo(
    () =>
      workingBatch
        .filter((a) => matchesFilter(a, filter))
        .sort((a, b) => a.lastEventAt - b.lastEventAt),
    [workingBatch, filter],
  );

  return { items, counts, filter, setFilter, connected };
}
