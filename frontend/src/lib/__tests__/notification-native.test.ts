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
  it('opens notification detail with an encoded ID rather than trusting arbitrary links', () => {
    expect(
      notificationTarget({
        notificationId: 'permission:p1',
        sessionId: 's1',
        url: 'https://bad.example',
      }),
    ).toBe('/notifications?item=permission%3Ap1');
    expect(notificationTarget({ sessionId: 's1' })).toBe('/chat/s1');
    expect(notificationTarget({})).toBe('/notifications');
  });
});
