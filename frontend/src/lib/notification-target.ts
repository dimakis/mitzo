/** Native push data selects a local route, never a producer-supplied URL. */
export function notificationTarget(data?: Record<string, unknown>): string {
  if (typeof data?.sessionId === 'string' && data.sessionId) {
    const chat = `/chat/${encodeURIComponent(data.sessionId)}`;
    return typeof data.notificationId === 'string' && data.notificationId.startsWith('permission:')
      ? `${chat}?approval=${encodeURIComponent(data.notificationId.slice('permission:'.length))}`
      : chat;
  }
  if (typeof data?.notificationId === 'string' && data.notificationId)
    return `/notifications?item=${encodeURIComponent(data.notificationId)}`;
  return '/notifications';
}
export const NOTIFICATIONS_REFRESH_EVENT = 'mitzo:notifications-refresh';
export const OPEN_NOTIFICATION_EVENT = 'mitzo:open-notification';

export function openNotification(data?: Record<string, unknown>): void {
  const handled = !window.dispatchEvent(
    new CustomEvent(OPEN_NOTIFICATION_EVENT, {
      detail: data ?? {},
      cancelable: true,
    }),
  );
  // Preserve cold-launch delivery if the router has not attached yet.
  if (!handled) window.location.href = notificationTarget(data);
}
