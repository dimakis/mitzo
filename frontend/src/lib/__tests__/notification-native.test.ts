// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
const setNotificationBadge = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' },
  registerPlugin: () => ({ setNotificationBadge }),
}));
import { syncNotificationBadge } from '../notification-badge';
import { notificationTarget } from '../notification-target';
describe('native notification navigation and badge', () => {
  it('clears stale badges with an authoritative zero', async () => {
    await syncNotificationBadge(0);
    expect(setNotificationBadge).toHaveBeenCalledWith({ count: 0 });
  });
  it('opens the exact approval in its chat without trusting arbitrary links', () => {
    expect(
      notificationTarget({
        notificationId: 'permission:p1',
        sessionId: 's1',
        url: 'https://bad.example',
      }),
    ).toBe('/chat/s1?approval=p1');
    expect(notificationTarget({ notificationId: 'permission:p/2', sessionId: 's/2' })).toBe(
      '/chat/s%2F2?approval=p%2F2',
    );
    expect(notificationTarget({ notificationId: 'turn:s1:2', sessionId: 's1' })).toBe('/chat/s1');
    expect(notificationTarget({ notificationId: 'permission:p1' })).toBe(
      '/notifications?item=permission%3Ap1',
    );
    expect(notificationTarget({ sessionId: 's1' })).toBe('/chat/s1');
    expect(notificationTarget({})).toBe('/notifications');
  });
});
