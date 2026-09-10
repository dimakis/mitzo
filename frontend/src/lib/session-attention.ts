import type { SessionActivity } from '@mitzo/protocol';

export function sessionAttentionReason(activity: SessionActivity) {
  const finished = activity.state === 'done' || activity.state === 'idle';
  if (finished && activity.awaitingReply) return 'awaiting-reply';
  if (activity.state === 'waiting') return 'waiting';
  if (finished && activity.uncommittedWork) return 'uncommitted-work';
  return null;
}
