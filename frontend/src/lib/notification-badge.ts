import { Capacitor, registerPlugin } from '@capacitor/core';
interface NotificationBadgePlugin {
  setNotificationBadge(options: { count: number }): Promise<void>;
}
let plugin: NotificationBadgePlugin | undefined;
export async function syncNotificationBadge(count: number): Promise<void> {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'ios') return;
  try {
    plugin ??= registerPlugin<NotificationBadgePlugin>('WatchAuthBridge');
    await plugin.setNotificationBadge({ count });
  } catch {
    /* Server APNs badge updates still work with older native binaries. */
  }
}
