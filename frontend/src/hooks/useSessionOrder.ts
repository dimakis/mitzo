import { useEffect, useRef, useState } from 'react';
import type { SessionActivity } from '@mitzo/protocol';
import type { Session } from '../types/chat';

// Scheduling policy, independent of animation timing. Bounded batches cannot be
// starved by continuous tool output, and successive batches have a cooldown.
const BATCH_MS = 600;
const MIN_REORDER_MS = 2500;

export function useSessionOrder(
  sessions: Session[],
  activities: SessionActivity[],
  paused: boolean,
): Session[] {
  const [ranks, setRanks] = useState(() => new Map(sessions.map((s) => [s.id, s.lastModified])));
  const model = useRef({
    ranks,
    observations: new Map<string, SessionActivity>(),
    pending: new Map<string, number>(),
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    lastCommit: -Infinity,
    loaded: sessions.length > 0,
  });

  useEffect(() => {
    const m = model.current;
    let seeded = false;
    const liveIds = new Set(activities.map((a) => a.sessionId));
    for (const session of sessions) {
      if (m.ranks.has(session.id)) {
        // Saved refresh is authoritative when no live projection is available.
        // A live tool signal must never leak into this fallback clock.
        if (!liveIds.has(session.id) && session.lastModified > (m.ranks.get(session.id) ?? 0))
          m.pending.set(session.id, session.lastModified);
        continue;
      }
      if (!seeded) m.ranks = new Map(m.ranks);
      seeded = true;
      // An older page can enter chronologically without displacing known rows.
      // Newly discovered rows wait below the list during an interaction.
      m.ranks.set(session.id, paused && m.loaded ? -Infinity : session.lastModified);
      if (paused && m.loaded) m.pending.set(session.id, session.lastModified);
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
        finished || needsAttention ? Math.max(activity.lastEventAt, previous ? Date.now() : 0) : 0,
      );
      if (eventAt > baseline)
        m.pending.set(
          activity.sessionId,
          Math.max(eventAt, m.pending.get(activity.sessionId) ?? 0),
        );
      m.observations.set(activity.sessionId, activity);
    }

    if (paused) {
      clearTimeout(m.timer);
      m.timer = undefined;
    } else if (m.pending.size && m.timer === undefined) {
      m.timer = setTimeout(
        () => {
          m.timer = undefined;
          m.ranks = new Map(m.ranks);
          for (const [id, time] of m.pending) m.ranks.set(id, Math.max(time, m.ranks.get(id) ?? 0));
          m.pending.clear();
          m.lastCommit = Date.now();
          setRanks(m.ranks);
        },
        Math.max(BATCH_MS, MIN_REORDER_MS - (Date.now() - m.lastCommit)),
      );
    }
  }, [sessions, activities, paused]);

  useEffect(
    () => () => {
      clearTimeout(model.current.timer);
      model.current.timer = undefined;
    },
    [],
  );
  return [...sessions].sort(
    (a, b) =>
      (ranks.get(b.id) ?? (paused ? -Infinity : b.lastModified)) -
        (ranks.get(a.id) ?? (paused ? -Infinity : a.lastModified)) || a.id.localeCompare(b.id),
  );
}
