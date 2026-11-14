import { useMemo, useSyncExternalStore } from 'react';
import {
  subscribeSessionActivity as subscribe,
  getSessionActivitySnapshot as getSnapshot,
} from '../lib/session-activity-store';
import { sessionNeedsYouReason } from '../lib/session-attention';
import type { SessionActivity } from '@mitzo/protocol';
import { conversationActivities } from '../lib/conversation-activity';

export type { SessionActivity, SessionActivityState, WaitReason } from '@mitzo/protocol';

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
  /** Display-only evidence; never use this to override current HTTP state. */
  lastKnownActivities: SessionActivity[];
}

export function useSessionOverview(conversations = false): UseSessionOverviewReturn {
  const { activities, lastKnownActivities, connected } = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot,
  );

  const projected = useMemo(
    () => (conversations ? conversationActivities(activities) : activities),
    [activities, conversations],
  );
  const retained = useMemo(
    () => (conversations ? conversationActivities(lastKnownActivities) : lastKnownActivities),
    [lastKnownActivities, conversations],
  );
  const sorted = useMemo(() => sortByTier(projected), [projected]);
  const attendCount = useMemo(
    () => projected.filter((a) => sessionNeedsYouReason(a) !== null).length,
    [projected],
  );

  return { activities: sorted, attendCount, connected, lastKnownActivities: retained };
}
