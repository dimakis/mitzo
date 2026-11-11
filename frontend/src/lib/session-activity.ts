import type { SessionActivity } from '@mitzo/protocol';
import type { Session } from '../types/chat';
import { isSessionActivityActive } from './session-attention';

export function mergeSessionActivities(
  sessions: Session[],
  activities: SessionActivity[],
): Map<string, Session> {
  const combined = new Map(sessions.map((s) => [s.id, s]));
  for (const a of activities) {
    const saved = combined.get(a.sessionId);
    combined.set(a.sessionId, {
      ...saved,
      id: a.sessionId,
      summary: saved?.summary || a.title,
      model: a.model ?? saved?.model,
      accountLabel: saved?.accountLabel ?? a.accountLabel,
      replyReadState: a.replyReadState ?? saved?.replyReadState,
      lastModified: saved?.lastModified ?? a.lastMessageAt ?? a.lastEventAt,
      isActive: isSessionActivityActive(a),
    });
  }
  return combined;
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
