/**
 * Push notification integration for Capacitor iOS.
 *
 * Requests notification permissions, registers the device token with
 * the Mitzo server, and handles incoming push notifications.
 *
 * No-op in browser environments.
 */

import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { apiFetch } from './api-fetch';

export async function initPushNotifications(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  const permission = await PushNotifications.requestPermissions();
  if (permission.receive !== 'granted') return;

  // Register listeners before calling register()
  await PushNotifications.addListener('registration', (token) => {
    apiFetch('/api/push/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: (token as { value: string }).value }),
    });
  });

  await PushNotifications.addListener('registrationError', (error) => {
    console.error('Push registration failed:', error);
  });

  await PushNotifications.addListener('pushNotificationReceived', (_notification) => {
    // Foreground notification — the app is already open, so no action needed.
    // The WS connection handles live updates.
  });

  await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
    // User tapped a notification — navigate to the relevant session
    const data = (action as { notification: { data: Record<string, string> } }).notification.data;
    if (data?.sessionId) {
      window.location.hash = '';
      window.location.pathname = `/chat/${data.sessionId}`;
    }
  });

  await PushNotifications.register();
}
