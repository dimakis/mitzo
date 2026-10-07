// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../notification-target', () => ({
  notificationTarget: vi.fn(() => '/notifications'),
  NOTIFICATIONS_REFRESH_EVENT: 'mitzo:notifications-refresh',
}));
import { notificationTarget } from '../notification-target';

// Mock @capacitor/core
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: vi.fn(() => false),
  },
}));

// Mock @capacitor/push-notifications — capture listeners
const pushListeners: Record<string, (data: unknown) => void> = {};
vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: {
    requestPermissions: vi.fn().mockResolvedValue({ receive: 'granted' }),
    register: vi.fn().mockResolvedValue(undefined),
    addListener: vi.fn((event: string, cb: (data: unknown) => void) => {
      pushListeners[event] = cb;
      return Promise.resolve();
    }),
  },
}));

// Mock api-fetch
vi.mock('../api-fetch', () => ({
  apiFetch: vi.fn().mockResolvedValue({ ok: true }),
  AUTH_RESTORED_EVENT: 'mitzo:auth-restored',
}));

import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { apiFetch } from '../api-fetch';
import { initPushNotifications, _resetForTest } from '../push';

beforeEach(() => {
  vi.clearAllMocks();
  _resetForTest();
  Object.keys(pushListeners).forEach((k) => delete pushListeners[k]);
  // Restore default mock returns after clearAllMocks resets them
  vi.mocked(PushNotifications.requestPermissions).mockResolvedValue({ receive: 'granted' });
  vi.mocked(PushNotifications.register).mockResolvedValue(undefined);
  vi.mocked(PushNotifications.addListener).mockImplementation(((
    event: string,
    cb: (data: unknown) => void,
  ) => {
    pushListeners[event] = cb;
    return Promise.resolve({ remove: vi.fn() });
  }) as typeof PushNotifications.addListener);
});

describe('initPushNotifications', () => {
  it.each(['ALLOW_ONCE_ACTION', 'ALLOW_SEARCH_SESSION_ACTION', 'DENY_PERMISSION_ACTION'])(
    'leaves %s to the native background handler without navigating or submitting twice',
    async (actionId) => {
      vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
      await initPushNotifications();
      pushListeners.pushNotificationActionPerformed({
        actionId,
        notification: { data: { sessionId: 's1', notificationId: 'permission:p1' } },
      });
      expect(apiFetch).not.toHaveBeenCalled();
      expect(notificationTarget).not.toHaveBeenCalled();
    },
  );
  it('queues login enrollment behind native registration still in flight', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    let finish!: () => void;
    vi.mocked(PushNotifications.register).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    vi.mocked(apiFetch).mockResolvedValueOnce({ ok: false, status: 401 } as Response);
    const setup = initPushNotifications();
    await vi.waitFor(() => expect(PushNotifications.register).toHaveBeenCalledOnce());
    pushListeners.registration({ value: 'device-token' });
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledOnce());
    window.dispatchEvent(new Event('mitzo:auth-restored'));
    finish();
    await setup;
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    expect(PushNotifications.addListener).toHaveBeenCalledTimes(4);
    expect(PushNotifications.register).toHaveBeenCalledOnce();
  });
  it.each(['registrationError', 'pushNotificationReceived', 'pushNotificationActionPerformed'])(
    'resumes listener setup after %s fails without duplicating installed callbacks',
    async (failedEvent) => {
      vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
      let failed = false;
      const installed: Record<string, Array<(data: unknown) => void>> = {};
      vi.mocked(PushNotifications.addListener).mockImplementation(((
        event: string,
        callback: (data: unknown) => void,
      ) => {
        if (event === failedEvent && !failed) {
          failed = true;
          return Promise.reject(new Error('Native listener setup failed'));
        }
        (installed[event] ??= []).push(callback);
        return Promise.resolve({ remove: vi.fn() });
      }) as typeof PushNotifications.addListener);
      await initPushNotifications();
      expect(PushNotifications.register).not.toHaveBeenCalled();
      window.dispatchEvent(new Event('mitzo:auth-restored'));
      // A simultaneous foreground retry must join the same setup attempt.
      await initPushNotifications();
      expect(PushNotifications.register).toHaveBeenCalledOnce();
      for (const callbacks of Object.values(installed)) expect(callbacks).toHaveLength(1);
      expect(Object.keys(installed)).toHaveLength(4);
      for (const callback of installed.registration) callback({ value: 'device-token' });
      expect(apiFetch).toHaveBeenCalledOnce();
    },
  );

  it('retries device enrollment after login without duplicating native listeners', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(apiFetch).mockResolvedValueOnce({ ok: false, status: 401 } as Response);
    await initPushNotifications();
    pushListeners.registration({ value: 'watch-alert-token' });
    await Promise.resolve();
    vi.mocked(apiFetch).mockClear();
    window.dispatchEvent(new Event('mitzo:auth-restored'));
    await Promise.resolve();
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/push/register',
      expect.objectContaining({
        body: JSON.stringify({ token: 'watch-alert-token' }),
      }),
    );
    await initPushNotifications();
    expect(PushNotifications.addListener).toHaveBeenCalledTimes(4);
  });

  it('retries notification permission after it was previously denied', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(PushNotifications.requestPermissions).mockResolvedValueOnce({ receive: 'denied' });
    await initPushNotifications();
    await initPushNotifications();
    expect(PushNotifications.register).toHaveBeenCalledOnce();
  });

  it('no-ops in browser environment', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    await initPushNotifications();
    expect(PushNotifications.requestPermissions).not.toHaveBeenCalled();
  });

  it('requests permissions on native platform', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    await initPushNotifications();
    expect(PushNotifications.requestPermissions).toHaveBeenCalled();
  });

  it('calls register after permission granted', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    await initPushNotifications();
    expect(PushNotifications.register).toHaveBeenCalled();
  });

  it('does not register when permission denied', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(PushNotifications.requestPermissions).mockResolvedValue({
      receive: 'denied',
    });
    await initPushNotifications();
    expect(PushNotifications.register).not.toHaveBeenCalled();
  });

  it('registers device token with server on registration event', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    await initPushNotifications();

    // Simulate registration success
    pushListeners['registration']({ value: 'device-token-xyz' });

    expect(apiFetch).toHaveBeenCalledWith('/api/push/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'device-token-xyz' }),
    });
  });

  it('preserves inline session replies when completion alerts also have a notification link', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    await initPushNotifications();
    pushListeners.pushNotificationActionPerformed({
      actionId: 'REPLY_ACTION',
      inputValue: 'Continue',
      notification: { data: { sessionId: 's1', notificationId: 'turn:s1:42' } },
    });
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/push/notification-action',
      expect.objectContaining({
        body: JSON.stringify({ sessionId: 's1', actionId: 'REPLY_ACTION', userText: 'Continue' }),
      }),
    );
  });
  it('registers listeners for push events', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    await initPushNotifications();

    expect(PushNotifications.addListener).toHaveBeenCalledWith(
      'registration',
      expect.any(Function),
    );
    expect(PushNotifications.addListener).toHaveBeenCalledWith(
      'registrationError',
      expect.any(Function),
    );
    expect(PushNotifications.addListener).toHaveBeenCalledWith(
      'pushNotificationReceived',
      expect.any(Function),
    );
    expect(PushNotifications.addListener).toHaveBeenCalledWith(
      'pushNotificationActionPerformed',
      expect.any(Function),
    );
  });
});
