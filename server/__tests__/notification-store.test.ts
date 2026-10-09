import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
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

it('expires a seat access notice without a local permission-queue entry', () => {
  const store = new NotificationStore(':memory:');
  try {
    store.record(
      {
        id: 'seat-access:request',
        kind: 'approval',
        title: 'Read site?',
        body: 'Open conversation',
        sessionId: 's1',
        expiresAt: 2000,
      },
      1000,
    );
    expect(store.feed('needs', 1500).needsYou).toBe(1);
    store.expire(2001);
    expect(store.feed('needs', 2001).needsYou).toBe(0);
  } finally {
    store.close();
  }
});

describe('notification archive', () => {
  it('archives resolved requests and read updates while preserving live requests and unread updates', () => {
    const store = new NotificationStore(':memory:');
    try {
      store.record(approval, 1000);
      store.record({ ...approval, id: 'resolved', permId: 'p2' }, 1000);
      store.resolvePermission('p2', 'allowed', 1100);
      store.record({ id: 'read', kind: 'session', title: 'Done', body: '' }, 1000);
      store.record({ id: 'unread', kind: 'update', title: 'New', body: '' }, 1000);
      store.markRead('read', 1100);
      store.queue('read', 1200);
      expect(store.archive(approval.id, 1200)).toBe(false);
      expect(store.archiveResolved(1200)).toBe(2);
      expect(
        store
          .feed('all', 1200)
          .items.map((i) => i.id)
          .sort(),
      ).toEqual([approval.id, 'unread'].sort());
      expect(store.feed('archived', 1200).total).toBe(2);
      expect(store.feed('all', 1200).needsYou).toBe(1);
      expect(store.get('resolved')?.resolution).toBe('allowed');
      expect(store.due(1300)).toEqual([]);
      expect(store.archive('unread', 1300)).toBe(true);
      expect(store.restore('read')).toBe(true);
      expect(store.get('read')?.archivedAt).toBeNull();
      expect(store.due(1400)).toEqual([]);
      expect(store.archiveResolved(1400)).toBe(1);
    } finally {
      store.close();
    }
  });
  it('migrates an existing database and keeps archived records across reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'notification-archive-'));
    const path = join(dir, 'state.db');
    const legacy = new Database(path);
    legacy.exec(`CREATE TABLE notifications (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, perm_id TEXT, created_at INTEGER NOT NULL,
      expires_at INTEGER, data TEXT NOT NULL, read_at INTEGER, resolved_at INTEGER, resolution TEXT,
      delivery_at INTEGER, delivery_status TEXT, delivery_attempts INTEGER NOT NULL DEFAULT 0
    )`);
    legacy.close();
    let store = new NotificationStore(path);
    try {
      store.record({ id: 'done', kind: 'session', title: 'Done', body: '' }, 1000);
      expect(store.archive('done', 1100)).toBe(true);
      store.close();
      store = new NotificationStore(path);
      expect(store.feed('all', 1200).total).toBe(0);
      expect(store.feed('archived', 1200).items[0].archivedAt).toBe(1100);
      expect(store.record({ id: 'done', kind: 'session', title: 'Replay', body: '' }, 1300)).toBe(
        false,
      );
      expect(store.get('done')?.archivedAt).toBe(1100);
    } finally {
      store.close();
      rmSync(dir, { recursive: true });
    }
  });
});
