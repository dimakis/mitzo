import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotificationStore } from '../notification-store.js';

const approval = {
  id: 'permission:p1',
  kind: 'approval' as const,
  title: 'Run tests?',
  body: 'npm test',
  sessionId: 's1',
  permId: 'p1',
  expiresAt: 2000,
};
describe('durable notification state', () => {
  it('deduplicates ingestion and keeps read separate from actionable state', () => {
    const store = new NotificationStore(':memory:');
    expect(store.record(approval, 1000)).toBe(true);
    expect(store.record(approval, 1001)).toBe(false);
    store.markRead(approval.id, 1100);
    expect(store.feed('all', 1200).needsYou).toBe(1);
    store.resolvePermission('p1', 'denied', 1300);
    expect(store.feed('needs', 1400).items).toEqual([]);
    expect(store.feed('history', 1400).items[0].resolution).toBe('denied');
    store.close();
  });
  it('expires old requests without granting them and survives reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'notifications-'));
    const path = join(dir, 'state.db');
    let store = new NotificationStore(path);
    store.record(approval, 1000);
    store.record(
      { id: 'turn:1', kind: 'session', title: 'Done', body: 'Summary', sessionId: 's1' },
      1001,
    );
    store.markUpdatesRead(1500);
    store.setPreferences({ questions: false, completion: 'off' });
    store.close();
    store = new NotificationStore(path);
    expect(store.feed('all', 2100).needsYou).toBe(0);
    expect(store.feed('history', 2100).items[0].resolution).toBe('expired');
    expect(store.get('turn:1')?.readAt).toBe(1500);
    expect(store.preferences().questions).toBe(false);
    store.close();
    rmSync(dir, { recursive: true });
  });
  it('limits feeds and reconciles live requests after restart', () => {
    const store = new NotificationStore(':memory:');
    store.record(approval, 1000);
    store.reconcilePermissions(() => false, 1100);
    expect(store.feed('needs', 1100).needsYou).toBe(0);
    expect(store.get(approval.id)?.resolution).toBe('expired');
    for (let i = 0; i < 205; i++)
      store.record({ id: `u${i}`, kind: 'update', title: 'Update', body: '' }, 1200 + i);
    expect(store.feed('all', 1600).items).toHaveLength(100);
    expect(store.feed('all', 1600, 100, 100).items).toHaveLength(100);
    store.close();
  });
  it('queues at most one delivery and excludes resolved/expired requests', () => {
    const store = new NotificationStore(':memory:');
    store.record(approval, 1000);
    store.queue(approval.id, 1500);
    store.queue(approval.id, 1500);
    expect(store.due(1400)).toEqual([]);
    expect(store.due(1500)).toHaveLength(1);
    store.resolvePermission('p1', 'allowed', 1600);
    expect(store.due(1700)).toEqual([]);
    store.close();
  });
});
