import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerPending, resolvePending, removePending } from '../permissions.js';
import { NotificationStore } from '../notification-store.js';
import { NotificationCenter, nextDeliveryAt } from '../notification-center.js';
import type { PermissionRequest } from '@mitzo/protocol';

const request: PermissionRequest = {
  permId: 'notify-perm',
  toolName: 'Bash',
  toolInput: 'npm test',
  sessionId: 'notify-session',
  expiresAt: Date.now() + 60000,
};
function setup(devices = () => 1) {
  const store = new NotificationStore(':memory:');
  const push = vi.fn().mockResolvedValue('accepted');
  const changed = vi.fn();
  const center = new NotificationCenter(store, {
    push,
    changed,
    configured: () => true,
    devices,
    sessionTitle: () => 'Fix notifications',
  });
  return { store, center, push, changed };
}
describe('central notification delivery', () => {
  afterEach(() => vi.useRealTimers());
  it.each(['resolved', 'expired', 'read'])(
    'does not send a later batched alert that becomes %s while an earlier push is in flight',
    async (change) => {
      vi.useFakeTimers();
      const { store, center, push } = setup();
      let finishFirst!: (status: string) => void;
      push.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve;
          }),
      );
      center.turnComplete('s1', 100, 'First', 'Tests', true);
      const later = { ...request, permId: `race-${change}`, expiresAt: Date.now() + 60000 };
      if (change === 'read') center.turnComplete('s1', 101, 'Later', 'Tests', true);
      else registerPending(later.permId, 'Bash', vi.fn(), {}, 'elevated', later.sessionId, later);
      const flushing = center.flush();
      expect(push).toHaveBeenCalledTimes(1);
      if (change === 'resolved') resolvePending(later.permId, 'deny');
      else if (change === 'expired') vi.advanceTimersByTime(60001);
      else store.markRead('turn:s1:101');
      finishFirst('accepted');
      await flushing;
      expect(push).toHaveBeenCalledTimes(1);
      expect(store.due()).toHaveLength(0);
      removePending(later.permId);
      center.close();
      store.close();
    },
  );
  it.each(['unavailable', 'no-device'])(
    'ages out queued informational pushes after %s without removing feed items',
    async (outage) => {
      vi.useFakeTimers();
      let deviceCount = outage === 'no-device' ? 0 : 1;
      const { store, center, push } = setup(() => deviceCount);
      push.mockResolvedValue('unavailable');
      center.turnComplete('s1', 90, 'Done', 'Tests', true);
      const testId = center.test();
      await center.flush();
      vi.advanceTimersByTime(13 * 60 * 60 * 1000);
      deviceCount = 1;
      push.mockClear().mockResolvedValue('accepted');
      await center.flush();
      expect(push).not.toHaveBeenCalled();
      expect(store.due()).toHaveLength(0);
      expect(store.get(testId)).toBeDefined();
      expect(store.get('turn:s1:90')).toMatchObject({ resolution: null });
      center.turnComplete('s1', 91, 'Fresh', 'Tests', true);
      center.test();
      await center.flush();
      expect(push).toHaveBeenCalledTimes(2);
      center.close();
      store.close();
    },
  );
  it('expires a queued test alert after five minutes while retaining a recent completion', async () => {
    vi.useFakeTimers();
    const { store, center, push } = setup();
    push.mockResolvedValue('unavailable');
    center.test();
    center.turnComplete('s1', 92, 'Done', 'Tests', true);
    await center.flush();
    vi.advanceTimersByTime(5 * 60 * 1000);
    push.mockClear().mockResolvedValue('accepted');
    await center.flush();
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0].data.type).toBe('session');
    expect(store.due()).toHaveLength(0);
    center.close();
    store.close();
  });
  it('captures and resolves permissions from any client without duplicate pushes', async () => {
    const { store, center, push } = setup();
    const resolve = vi.fn();
    registerPending(request.permId, 'Bash', resolve, {}, 'elevated', request.sessionId, request);
    expect(store.feed('needs').needsYou).toBe(1);
    await center.flush();
    await center.flush();
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0].body).not.toContain('npm test');
    expect(resolvePending(request.permId, 'once', undefined, request.sessionId)).toBe(true);
    expect(store.feed('needs').needsYou).toBe(0);
    expect(store.get(`permission:${request.permId}`)?.resolution).toBe('allowed');
    center.close();
    store.close();
  });
  it('records completion once and honors unattended/off preferences at delivery', async () => {
    const { store, center, push } = setup();
    center.turnComplete('s1', 42, 'Summary', 'Tests', false);
    center.turnComplete('s1', 42, 'Summary', 'Tests', false);
    await center.flush();
    expect(push).not.toHaveBeenCalled();
    expect(store.feed().items).toHaveLength(1);
    center.turnComplete('s1', 43, 'Summary', 'Tests', true);
    store.setPreferences({ completion: 'off' });
    await center.flush();
    expect(push).not.toHaveBeenCalled();
    center.close();
    store.close();
  });
  it('retains native session reply actions for completion alerts', async () => {
    const { store, center, push } = setup();
    center.turnComplete('s1', 55, 'Done', 'Tests', true);
    await center.flush();
    expect(push.mock.calls[0][0].category).toBe('SESSION_UPDATE');
    center.close();
    store.close();
  });
  it('never delivers expired approvals or replays previous notifications on restart', async () => {
    const { store, center, push } = setup();
    registerPending(request.permId, 'Bash', vi.fn(), {}, 'elevated', request.sessionId, request);
    removePending(request.permId);
    await center.flush();
    expect(push).not.toHaveBeenCalled();
    expect(store.feed('history').items[0].resolution).toBe('expired');
    center.close();
    store.close();
  });
  it('cancels queued informational alerts after reading without cancelling pending decisions', async () => {
    const { store, center, push } = setup();
    center.turnComplete('s1', 70, 'Done', 'Tests', true);
    store.markRead('turn:s1:70');
    await center.flush();
    expect(push).not.toHaveBeenCalled();
    registerPending(request.permId, 'Bash', vi.fn(), {}, 'elevated', request.sessionId, request);
    store.markRead(`permission:${request.permId}`);
    await center.flush();
    expect(push).toHaveBeenCalledTimes(1);
    removePending(request.permId);
    center.close();
    store.close();
  });
  it('defers quiet-hour delivery in the selected timezone and permits all-day quiet', () => {
    const { store, center } = setup();
    const prefs = store.setPreferences({
      quietHours: true,
      quietStart: '22:00',
      quietEnd: '08:00',
      timezone: 'Europe/Dublin',
    });
    const now = Date.parse('2026-10-03T22:30:00Z');
    expect(nextDeliveryAt(prefs, now)).toBe(Date.parse('2026-10-04T07:00:00Z'));
    expect(nextDeliveryAt({ ...prefs, quietEnd: '22:00' }, now)).toBeNull();
    center.close();
    store.close();
  });
});
