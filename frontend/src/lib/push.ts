// Push notification integration for Capacitor iOS. No-op in browser.

import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { apiFetch } from './api-fetch';

let initialized = false;

/** @internal test-only — reset the init guard */
export function _resetForTest(): void {
  initialized = false;
}

export async function initPushNotifications(): Promise<void> {
  if (!Capacitor.isNativePlatform() || initialized) return;
  initialized = true;

  const permission = await PushNotifications.requestPermissions();
  if (permission.receive !== 'granted') return;

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
    // Foreground — WS handles live updates, no action needed
  });

  await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
    const data = (action as { notification: { data: Record<string, string> } }).notification.data;
    if (data?.sessionId) {
      window.location.href = `/chat/${data.sessionId}`;
    }
  });

  await PushNotifications.register();
}
