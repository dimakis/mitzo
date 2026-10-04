/** Native push data selects a local route, never a producer-supplied URL. */
export function notificationTarget(data?: Record<string, unknown>): string {
  if (typeof data?.notificationId === 'string' && data.notificationId)
    return `/notifications?item=${encodeURIComponent(data.notificationId)}`;
  if (typeof data?.sessionId === 'string' && data.sessionId)
    return `/chat/${encodeURIComponent(data.sessionId)}`;
  return '/notifications';
}
export const NOTIFICATIONS_REFRESH_EVENT = 'mitzo:notifications-refresh';
