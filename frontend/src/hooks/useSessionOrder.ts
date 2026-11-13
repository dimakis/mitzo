import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionActivity } from '@mitzo/protocol';
import type { Session } from '../types/chat';
import { isSessionActivityActive } from '../lib/session-attention';

export function conversationGroup(session: Session, activity?: SessionActivity) {
  return (activity ? isSessionActivityActive(activity) : session.isActive) ? 0 : 1;
}

// Scheduling policy, independent of animation timing. Bounded batches cannot be
// starved by continuous tool output, and successive batches have a cooldown.
const BATCH_MS = 600;
const MIN_REORDER_MS = 5000;
function observedRank(session: Session, activity?: SessionActivity) {
  return Math.max(
    session.lastModified,
    activity?.lastMessageAt ?? 0,
    activity?.lastUserMessageAt ?? 0,
    activity?.state === 'done' ? (activity.completedAt ?? activity.lastEventAt) : 0,
    activity?.state === 'waiting' ? (activity.stateChangedAt ?? activity.lastEventAt) : 0,
  );
}

export function useSessionOrder(
  sessions: Session[],
  activities: SessionActivity[],
  paused: boolean,
): Session[] {
  return useSessionOrdering(sessions, activities, paused).sessions;
}

export function useSessionOrdering(
  sessions: Session[],
  activities: SessionActivity[],
  paused: boolean,
  { grouped = false }: { grouped?: boolean } = {},
) {
  const activityById = useMemo(
    () => new Map(activities.map((activity) => [activity.sessionId, activity])),
    [activities],
  );
  const [ranks, setRanks] = useState(
    () => new Map(sessions.map((s) => [s.id, observedRank(s, activityById.get(s.id))])),
  );
  const [pendingCount, setPendingCount] = useState(0);
  const [groups, setGroups] = useState(
    () => new Map(sessions.map((s) => [s.id, conversationGroup(s, activityById.get(s.id))])),
  );
  const model = useRef({
    ranks,
    groups,
    pendingGroups: new Map<string, number>(),
    observations: new Map(activities.map((activity) => [activity.sessionId, activity])),
    pending: new Map<string, number>(),
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    lastCommit: -Infinity,
    loaded: sessions.length > 0,
    hydrationHeld: false,
    hydrated: activities.length > 0,
  });
  const showLatest = useCallback(() => {
    const m = model.current;
    if (Date.now() - m.lastCommit < MIN_REORDER_MS) return;
    clearTimeout(m.timer);
    m.timer = undefined;
    m.hydrationHeld = false;
    if (!m.pending.size) return;
    m.ranks = new Map(m.ranks);
    // One promotion per movement, including explicit Show latest. Repeated
    // observations coalesce by session rather than building an animation backlog.
    // Drain group changes in arrival order before recency promotions so a stream
    // of newer active replies cannot strand finished work in the active group.
    const pending = [...m.pending];
    const [id, time] =
      pending.find(
        ([sessionId]) =>
          m.pendingGroups.has(sessionId) &&
          m.pendingGroups.get(sessionId) !== m.groups.get(sessionId),
      ) ?? pending.sort((a, b) => b[1] - a[1])[0];
    m.ranks.set(id, Math.max(time, m.ranks.get(id) ?? 0));
    m.pending.delete(id);
    if (m.pendingGroups.has(id)) {
      m.groups = new Map(m.groups).set(id, m.pendingGroups.get(id)!);
      m.pendingGroups.delete(id);
      setGroups(m.groups);
    }
    m.lastCommit = Date.now();
    setRanks(m.ranks);
    setPendingCount(m.pending.size);
  }, []);

  useEffect(() => {
    const m = model.current;
    let seeded = false;
    const seededIds = new Set<string>();
    const initialHydration = !m.hydrated && activities.length > 0;
    const liveIds = new Set(activities.map((a) => a.sessionId));
    const presentIds = new Set(sessions.map((s) => s.id));
    for (const id of m.pending.keys())
      if (!presentIds.has(id)) {
        m.pending.delete(id);
        m.pendingGroups.delete(id);
      }
    for (const session of sessions) {
      const group = conversationGroup(session, activityById.get(session.id));
      if (!m.groups.has(session.id)) {
        m.groups = new Map(m.groups).set(session.id, m.loaded ? 1 : group);
        if (m.loaded && grouped) m.pendingGroups.set(session.id, group);
        setGroups(m.groups);
      } else if (grouped && m.groups.get(session.id) !== group) {
        if (initialHydration && !m.observations.has(session.id) && m.loaded) m.hydrationHeld = true;
        m.pendingGroups.set(session.id, group);
        m.pending.set(
          session.id,
          Math.max(
            observedRank(session, activityById.get(session.id)),
            m.pending.get(session.id) ?? 0,
          ),
        );
      } else m.pendingGroups.delete(session.id);
      if (m.ranks.has(session.id)) {
        // Saved refresh is authoritative when no live projection is available.
        // A live tool signal must never leak into this fallback clock.
        if (!liveIds.has(session.id) && session.lastModified > (m.ranks.get(session.id) ?? 0))
          m.pending.set(session.id, Math.max(session.lastModified, m.pending.get(session.id) ?? 0));
        continue;
      }
      if (!seeded) m.ranks = new Map(m.ranks);
      seeded = true;
      seededIds.add(session.id);
      // An older page can enter chronologically without displacing known rows.
      // Newly discovered rows wait below the list during an interaction.
      m.ranks.set(
        session.id,
        m.loaded
          ? -Infinity
          : observedRank(
              session,
              activities.find((activity) => activity.sessionId === session.id),
            ),
      );
      if (m.loaded) m.pending.set(session.id, observedRank(session, activityById.get(session.id)));
    }
    if (seeded) setRanks(m.ranks);
    if (sessions.length) m.loaded = true;

    for (const activity of activities) {
      const previous = m.observations.get(activity.sessionId);
      const baseline = m.ranks.get(activity.sessionId) ?? 0;
      const userAt = activity.lastUserMessageAt ?? 0;
      const messageAt = activity.lastMessageAt ?? 0;
      const newAssistantMessage = messageAt > (previous?.lastMessageAt ?? baseline);
      const newMessage = userAt > (previous?.lastUserMessageAt ?? baseline);
      const finished = activity.state === 'done' && previous?.state !== 'done';
      const needsAttention =
        activity.state === 'waiting' &&
        (previous?.state !== 'waiting' || previous.waitReason !== activity.waitReason);
      const eventAt = Math.max(
        newMessage ? userAt : 0,
        newAssistantMessage ? messageAt : 0,
        // Permission creation need not touch lastEventAt. For a transition we
        // actually witnessed, use its observation time; hydration keeps source
        // chronology rather than making old attention items newly recent.
        finished
          ? (activity.completedAt ?? Math.max(activity.lastEventAt, previous ? Date.now() : 0))
          : 0,
        needsAttention
          ? (activity.stateChangedAt ?? Math.max(activity.lastEventAt, previous ? Date.now() : 0))
          : 0,
      );
      if (eventAt > baseline) {
        // The first late projection enriches already painted rows without
        // treating hydration as a new message. Offer its order via Show latest.
        if (initialHydration && !previous && m.loaded && !seededIds.has(activity.sessionId))
          m.hydrationHeld = true;
        else if (previous) m.hydrationHeld = false;
        m.pending.set(
          activity.sessionId,
          Math.max(eventAt, m.pending.get(activity.sessionId) ?? 0),
        );
      }
      m.observations.set(activity.sessionId, activity);
    }
    if (activities.length) m.hydrated = true;
    setPendingCount(m.pending.size);

    if (paused || m.hydrationHeld) {
      clearTimeout(m.timer);
      m.timer = undefined;
    } else if (m.pending.size && m.timer === undefined) {
      m.timer = setTimeout(
        showLatest,
        Math.max(BATCH_MS, MIN_REORDER_MS - (Date.now() - m.lastCommit)),
      );
    }
  }, [sessions, activities, paused, showLatest, ranks, grouped, activityById]);

  useEffect(
    () => () => {
      clearTimeout(model.current.timer);
      model.current.timer = undefined;
    },
    [],
  );
  const ordered = [...sessions].sort(
    (a, b) =>
      (grouped ? (groups.get(a.id) ?? 1) - (groups.get(b.id) ?? 1) : 0) ||
      (ranks.get(b.id) ??
        (model.current.loaded ? -Infinity : observedRank(b, activityById.get(b.id)))) -
        (ranks.get(a.id) ??
          (model.current.loaded ? -Infinity : observedRank(a, activityById.get(a.id)))) ||
      a.id.localeCompare(b.id),
  );
  return { sessions: ordered, groups, pendingCount, showLatest };
}
