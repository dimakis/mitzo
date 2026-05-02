import { useState, useEffect, useMemo } from 'react';
import { eventBus } from '../lib/event-bus-singleton';

// ─── Types (mirror server/session-overview.ts) ──────────────────────────────

export type SessionActivityState = 'init' | 'working' | 'waiting' | 'done' | 'idle' | 'paused';

export type WaitReason = 'permission' | 'review' | 'blocked';

export interface SessionActivity {
  sessionId: string;
  clientId: string;
  title: string;
  repo?: string;
  state: SessionActivityState;
  flags: SessionActivityState[];
  waitReason?: WaitReason;
  progress?: { done: number; total: number };
  lastEventAt: number;
  taskId?: string;
}

// ─── Tier sorting ───────────────────────────────────────────────────────────

type AttendTier = 1 | 2 | 3 | 4;

function getTier(activity: SessionActivity): AttendTier {
  if (activity.state === 'waiting') return 1;
  if (activity.state === 'done') return 2;
  if (activity.state === 'working') return 3;
  return 4; // init, idle, paused
}

function sortByTier(activities: SessionActivity[]): SessionActivity[] {
  return [...activities].sort((a, b) => {
    const tierDiff = getTier(a) - getTier(b);
    if (tierDiff !== 0) return tierDiff;
    // Within same tier, most recent first
    return b.lastEventAt - a.lastEventAt;
  });
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export interface UseSessionOverviewReturn {
  /** All active sessions, sorted by attention tier. */
  activities: SessionActivity[];
  /** Number of Tier 1 (needs you) sessions. */
  attendCount: number;
  /** Whether SSE is connected. */
  connected: boolean;
}

export function useSessionOverview(): UseSessionOverviewReturn {
  const [activities, setActivities] = useState<SessionActivity[]>([]);
  const [connected, setConnected] = useState(eventBus.connected);

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

  const sorted = useMemo(() => sortByTier(activities), [activities]);
  const attendCount = useMemo(
    () => activities.filter((a) => a.state === 'waiting').length,
    [activities],
  );

  return { activities: sorted, attendCount, connected };
}
