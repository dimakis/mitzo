import { afterEach, describe, expect, it } from 'vitest';
import { NotificationStore } from '../notification-store.js';

const stores: NotificationStore[] = [];
function store() {
  const value = new NotificationStore(':memory:');
  stores.push(value);
  return value;
}
const request = {
  id: 'permission:p1',
  kind: 'approval' as const,
  permId: 'p1',
  sessionId: 's1',
  title: 'Read source?',
  body: 'A bounded request',
  expiresAt: 5000,
};
afterEach(() => stores.splice(0).forEach((value) => value.close()));

describe('automatic Inbox archive', () => {
  it.each(['allowed', 'denied', 'expired'] as const)(
    'archives a %s request and preserves its audit receipt',
    (resolution) => {
      const db = store();
      db.record(request, 1000);
      db.queue(request.id, 2000);
      db.resolvePermission('p1', resolution, 1500);
      expect(db.get(request.id)).toMatchObject({ resolvedAt: 1500, archivedAt: 1500, resolution });
      expect(db.feed('all', 1600).total).toBe(0);
      expect(db.feed('archived', 1600).items[0].id).toBe(request.id);
      expect(db.feed('history', 1600).items[0].resolution).toBe(resolution);
      expect(db.due(2500)).toEqual([]);
    },
  );

  it('archives expirations, including provider-owned seat requests', () => {
    const db = store();
    db.record(request, 1000);
    db.record({ ...request, id: 'seat-access:r1', permId: undefined }, 1000);
    expect(db.expire(5001)).toBe(2);
    expect(db.feed('all', 5002).total).toBe(0);
    expect(db.feed('archived', 5002).total).toBe(2);
    expect(db.feed('needs', 5002).needsYou).toBe(0);
  });

  it('keeps questions visible until their actual resolution', () => {
    const db = store();
    db.record({ ...request, kind: 'question' }, 1000);
    db.markRead(request.id, 1100);
    expect(db.get(request.id)?.archivedAt).toBeNull();
    expect(db.feed('needs', 1200).needsYou).toBe(1);
    db.resolvePermission('p1', 'allowed', 1300);
    expect(db.get(request.id)?.archivedAt).toBe(1300);
  });

  it('archives a resolved seat request only for its owning session', () => {
    const db = store();
    db.record({ ...request, id: 'seat-access:r1', permId: undefined }, 1000);
    expect(db.resolveSessionNotice('seat-access:r1', 'other', 'allowed', 1100)).toBe(0);
    expect(db.feed('needs', 1200).needsYou).toBe(1);
    expect(db.resolveSessionNotice('seat-access:r1', 's1', 'allowed', 1300)).toBe(1);
    expect(db.get('seat-access:r1')?.archivedAt).toBe(1300);
  });

  it('archives an acknowledged session update and cancels any delayed push', () => {
    const db = store();
    db.record(
      { id: 'turn:s1:1', kind: 'session', sessionId: 's1', title: 'Done', body: 'Result' },
      1000,
    );
    db.queue('turn:s1:1', 2000);
    expect(db.feed('all', 1100).total).toBe(1);
    db.markRead('turn:s1:1', 1200);
    expect(db.get('turn:s1:1')).toMatchObject({ readAt: 1200, archivedAt: 1200 });
    expect(db.due(2500)).toEqual([]);
  });

  it('bulk acknowledgement archives sessions while leaving actionable requests and other sources alone', () => {
    const db = store();
    db.record(request, 1000);
    db.record({ id: 'turn:s1:1', kind: 'session', title: 'Done', body: 'Result' }, 1000);
    db.record({ id: 'briefing:1', kind: 'update', title: 'Briefing', body: 'Report' }, 1000);
    db.markUpdatesRead(1200);
    expect(db.get('turn:s1:1')?.archivedAt).toBe(1200);
    expect(db.get(request.id)?.archivedAt).toBeNull();
    expect(db.get(request.id)?.resolvedAt).toBeNull();
    expect(db.get('briefing:1')?.archivedAt).toBeNull();
  });
});
