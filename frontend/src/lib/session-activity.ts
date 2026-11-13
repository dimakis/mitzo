import type { SessionActivity } from '@mitzo/protocol';
import type { Session } from '../types/chat';
import { isSessionActivityActive } from './session-attention';

export type ModelObservation = Pick<Session, 'model' | 'modelUnavailable' | 'modelObservedAt'>;
function observedAt(value: ModelObservation | undefined): number | undefined {
  const at = value?.modelObservedAt;
  return typeof at === 'number' && Number.isSafeInteger(at) && at >= 0 ? at : undefined;
}

/** Keep the latest display observation together, including explicit uncertainty.
 * Server read times are presentation hints, never command/admission evidence. */
export function mergeSessionModel(
  primary: ModelObservation | undefined,
  fallback: ModelObservation | undefined,
): ModelObservation {
  const primaryAt = observedAt(primary);
  const fallbackAt = observedAt(fallback);
  let selected: ModelObservation | undefined;
  if (primaryAt !== undefined || fallbackAt !== undefined) {
    selected =
      primaryAt === fallbackAt
        ? fallback?.modelUnavailable
          ? fallback
          : primary
        : (primaryAt ?? -1) > (fallbackAt ?? -1)
          ? primary
          : fallback;
  } else {
    selected = primary?.modelUnavailable || primary?.model !== undefined ? primary : fallback;
  }
  return {
    model: selected?.modelUnavailable ? undefined : selected?.model,
    modelUnavailable: selected?.modelUnavailable === true,
    modelObservedAt: observedAt(selected),
  };
}

export function mergeSessionActivities(
  sessions: Session[],
  activities: SessionActivity[],
  lastKnownActivities: SessionActivity[] = [],
  observations = new Map<string, ModelObservation>(),
): Map<string, Session> {
  const combined = new Map(
    sessions.map((s) => [s.id, { ...s, ...retainSessionModel(observations, s.id, s) }]),
  );
  // Retain model uncertainty across disconnect without reviving stale activity.
  for (const a of lastKnownActivities) {
    const saved = combined.get(a.sessionId);
    if (saved)
      combined.set(a.sessionId, {
        ...saved,
        ...retainSessionModel(observations, a.sessionId, a),
      });
  }
  for (const a of activities) {
    const saved = combined.get(a.sessionId);
    combined.set(a.sessionId, {
      ...saved,
      id: a.sessionId,
      summary: saved?.summary || a.title,
      ...retainSessionModel(observations, a.sessionId, a),
      accountLabel: saved?.accountLabel ?? a.accountLabel,
      replyReadState: a.replyReadState ?? saved?.replyReadState,
      lastModified: saved?.lastModified ?? a.lastMessageAt ?? a.lastEventAt,
      isActive: isSessionActivityActive(a),
    });
  }
  return combined;
}

/** A presentation cache survives search/connection transitions, never a session binding. */
export function retainSessionModel(
  observations: Map<string, ModelObservation>,
  sessionId: string,
  observation: ModelObservation,
): ModelObservation {
  const latest = mergeSessionModel(observation, observations.get(sessionId));
  observations.set(sessionId, latest);
  return latest;
}
export function sessionActivityLabel(activity: SessionActivity): string {
  if (activity.state === 'waiting')
    return activity.waitReason === 'permission'
      ? 'Permission needed'
      : activity.waitReason === 'review'
        ? 'Review needed'
        : activity.waitReason === 'blocked'
          ? 'Blocked'
          : 'Needs attention';
  if (activity.state === 'working')
    return activity.phase
      ? {
          reading: 'Reading files',
          editing: 'Editing files',
          command: 'Running command',
          tool: 'Using tools',
          reply: 'Writing a reply',
          thinking: 'Thinking',
        }[activity.phase]
      : 'Working';
  return { init: 'Starting', done: 'Finished', idle: 'Idle', paused: 'Paused' }[activity.state];
}
export function elapsedTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}
