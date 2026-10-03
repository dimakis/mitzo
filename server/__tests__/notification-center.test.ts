import { describe, it, expect, vi } from 'vitest';
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
function setup() {
  const store = new NotificationStore(':memory:');
  const push = vi.fn().mockResolvedValue('accepted');
  const changed = vi.fn();
  const center = new NotificationCenter(store, {
    push,
    changed,
    configured: () => true,
    devices: () => 1,
    sessionTitle: () => 'Fix notifications',
  });
  return { store, center, push, changed };
}
describe('central notification delivery', () => {
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
