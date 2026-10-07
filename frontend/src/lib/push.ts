import { notificationTarget, NOTIFICATIONS_REFRESH_EVENT } from './notification-target';
// Push notification integration for Capacitor iOS. No-op in browser.

import { Capacitor } from '@capacitor/core';
import { PushNotifications, type ActionPerformed } from '@capacitor/push-notifications';
import { apiFetch, AUTH_RESTORED_EVENT } from './api-fetch';

let initialized = false;
let initialization: Promise<void> | undefined;
let deviceToken: string | undefined;
let authListener: (() => void) | undefined;
const installedListeners = new Set<string>();

async function installListenerOnce(event: string, install: () => Promise<unknown>): Promise<void> {
  if (installedListeners.has(event)) return;
  await install();
  // Keep successful listeners across partial failures; the shared initialization
  // promise serializes retries, which resume at the first missing listener.
  installedListeners.add(event);
}

async function enrollDevice(): Promise<void> {
  if (!deviceToken) return;
  try {
    const response = await apiFetch('/api/push/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: deviceToken }),
    });
    if (!response.ok) console.warn('Push device enrollment failed:', response.status);
  } catch (error) {
    console.warn('Push device enrollment failed:', error);
  }
}

/** @internal test-only — reset the init guard */
export function _resetForTest(): void {
  initialized = false;
  initialization = undefined;
  deviceToken = undefined;
  if (authListener) window.removeEventListener(AUTH_RESTORED_EVENT, authListener);
  authListener = undefined;
  installedListeners.clear();
}

export async function initPushNotifications(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  if (!authListener) {
    authListener = () => {
      void initPushNotifications();
    };
    window.addEventListener(AUTH_RESTORED_EVENT, authListener);
  }
  if (initialization) return initialization;
  initialization = initializePush()
    .catch((error) => {
      console.warn('Push setup failed:', error);
    })
    .finally(() => {
      initialization = undefined;
    });
  return initialization;
}

async function initializePush(): Promise<void> {
  if (initialized) {
    if (deviceToken) await enrollDevice();
    else await PushNotifications.register();
    return;
  }

  const permission = await PushNotifications.requestPermissions();
  if (permission.receive !== 'granted') return;

  await installListenerOnce('registration', () =>
    PushNotifications.addListener('registration', (token) => {
      deviceToken = (token as { value: string }).value;
      void enrollDevice();
    }),
  );

  await installListenerOnce('registrationError', () =>
    PushNotifications.addListener('registrationError', (error) => {
      console.error('Push registration failed:', error);
    }),
  );

  await installListenerOnce('pushNotificationReceived', () =>
    PushNotifications.addListener('pushNotificationReceived', (_notification) => {
      window.dispatchEvent(new Event(NOTIFICATIONS_REFRESH_EVENT));
    }),
  );

  await installListenerOnce('pushNotificationActionPerformed', () =>
    PushNotifications.addListener('pushNotificationActionPerformed', (action: ActionPerformed) => {
      const { actionId, inputValue } = action;
      if (
        ['ALLOW_ONCE_ACTION', 'ALLOW_SEARCH_SESSION_ACTION', 'DENY_PERMISSION_ACTION'].includes(
          actionId,
        )
      ) {
        window.dispatchEvent(new Event(NOTIFICATIONS_REFRESH_EVENT));
        return; // Native code already submitted this action without foregrounding the app.
      }
      const data = action.notification.data as Record<string, string> | undefined;
      const sessionId = data?.sessionId;
      if (data?.notificationId && actionId !== 'REPLY_ACTION' && actionId !== 'LATER_ACTION') {
        window.location.href = notificationTarget(data);
        return;
      }

      if (sessionId && actionId === 'REPLY_ACTION' && inputValue) {
        // Send reply text to the session, then navigate
        apiFetch('/api/push/notification-action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, actionId, userText: inputValue }),
        })
          .then(() => {
            window.location.href = `/chat/${sessionId}`;
          })
          .catch(() => {
            // Still navigate — user can resend from chat view
            window.location.href = `/chat/${sessionId}`;
          });
      } else if (sessionId) {
        if (actionId === 'LATER_ACTION') {
          apiFetch('/api/push/notification-action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, actionId }),
          });
        } else {
          // VIEW_ACTION or default tap — just navigate
          window.location.href = `/chat/${sessionId}`;
        }
      }
    }),
  );

  initialized = true;
  await PushNotifications.register();
}
