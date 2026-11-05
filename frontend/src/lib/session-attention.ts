import type { SessionActivity } from '@mitzo/protocol';

export function isSessionActivityActive(activity: SessionActivity): boolean {
  return activity.state !== 'done' && activity.state !== 'idle';
}

/** Confirmed user actions only. Last speaker and worktree state are not requests. */
export function sessionNeedsYouReason(activity: SessionActivity) {
  if (activity.state !== 'waiting') return null;
  return activity.waitReason === 'permission' || activity.waitReason === 'review'
    ? activity.waitReason
    : null;
}

export function sessionAttentionReason(activity: SessionActivity) {
  const finished = !isSessionActivityActive(activity);
  if (finished && activity.awaitingReply) return 'awaiting-reply';
  if (activity.state === 'waiting') return 'waiting';
  if (finished && activity.uncommittedWork) return 'uncommitted-work';
  return null;
}
