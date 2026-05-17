// Push notification integration for Capacitor iOS. No-op in browser.

import { Capacitor } from '@capacitor/core';
import { PushNotifications, type ActionPerformed } from '@capacitor/push-notifications';
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

  await PushNotifications.addListener('pushNotificationActionPerformed', (action: ActionPerformed) => {
    const { actionId, inputValue } = action;
    const data = action.notification.data as Record<string, string> | undefined;
    const sessionId = data?.sessionId;

    if (sessionId && actionId === 'REPLY_ACTION' && inputValue) {
      // Send reply text to the session, then navigate
      apiFetch('/api/push/notification-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, actionId, userText: inputValue }),
      }).finally(() => {
        window.location.href = `/chat/${sessionId}`;
      });
    } else if (sessionId) {
      // VIEW_ACTION, LATER_ACTION, or default tap — navigate to session
      if (actionId && actionId !== 'VIEW_ACTION') {
        apiFetch('/api/push/notification-action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, actionId }),
        });
      }
      if (actionId !== 'LATER_ACTION') {
        window.location.href = `/chat/${sessionId}`;
      }
    }
  });

  await PushNotifications.register();
}
