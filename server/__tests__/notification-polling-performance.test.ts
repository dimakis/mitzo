import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotificationStore } from '../notification-store.js';
import { NotificationCenter } from '../notification-center.js';
import type { MitzoNotification } from '@mitzo/protocol';

type Input = Parameters<NotificationStore['record']>[0];
const notice = (id: string, extra: Partial<Input> = {}): Input => ({
  id,
  kind: 'update',
  title: id,
  body: '',
  inboxFilename: `${id}.md`,
  ...extra,
});
const alert: NonNullable<MitzoNotification['inbox']> = {
  agent: 'synthetic',
  tags: [],
  category: 'alert',
  severity: 'warning',
  needsAttention: true,
  status: 'pending',
};

function database(store: NotificationStore): Database.Database {
  return (store as unknown as { db: Database.Database }).db;
}
function seedHistory(store: NotificationStore) {
  database(store).transaction(() => {
    for (let i = 0; i < 1857; i++) store.record(notice(`history-${i}`), 1000 + i);
  })();
}
function actualPlans(store: NotificationStore, action: () => unknown) {
  const db = database(store);
  const prepare = vi.spyOn(db, 'prepare');
  action();
  const queries = prepare.mock.calls.map(([sql]) => sql);
  prepare.mockRestore();
  return queries.map((sql) => ({
    sql,
    details: (
      db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...Array((sql.match(/\?/g) ?? []).length).fill(5000)) as { detail: string }[]
    )
      .map((row) => row.detail)
      .join('; '),
  }));
}

describe.each(['fresh', 'legacy'] as const)('%s notification polling', (schema) => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'notification-polling-'));
    const path = join(dir, 'state.db');
    if (schema === 'legacy') {
      const old = new Database(path);
      old.exec(`CREATE TABLE notifications (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, perm_id TEXT, created_at INTEGER NOT NULL,
        expires_at INTEGER, data TEXT NOT NULL, read_at INTEGER, resolved_at INTEGER, resolution TEXT,
        delivery_at INTEGER, delivery_status TEXT, delivery_attempts INTEGER NOT NULL DEFAULT 0
      )`);
      old
        .prepare('INSERT INTO notifications(id,kind,created_at,data) VALUES(?,?,?,?)')
        .run('legacy-row', 'update', 1, JSON.stringify({ ...notice('legacy-row'), createdAt: 1 }));
      old.close();
    }
    const store = new NotificationStore(path);
    return {
      store,
      close: () => {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  it('does no visibility work for an empty delivery queue despite retained history', () => {
    const { store, close } = setup();
    try {
      seedHistory(store);
      const visible = vi.fn(() => true);
      store.setInboxReadPolicy(() => visible);
      expect(store.due(5000)).toEqual([]);
      expect(visible).not.toHaveBeenCalled();
      const plans = actualPlans(store, () => store.reconcilePermissions(() => true, 5000));
      expect(plans.find((plan) => plan.sql.startsWith('UPDATE'))?.details).toContain(
        'USING INDEX notifications_expiring',
      );
      expect(plans.find((plan) => plan.sql.startsWith('SELECT perm_id'))?.details).toContain(
        'USING INDEX notifications_live_permissions',
      );
    } finally {
      close();
    }
  });

  it('checks privacy only for due candidates and preserves delivery state, order and limit', () => {
    const { store, close } = setup();
    try {
      seedHistory(store);
      for (let i = 0; i < 30; i++) {
        store.record(notice(`due-${i}`), 1000);
        store.queue(`due-${i}`, 2000 + i);
      }
      store.record(notice('private'), 1000);
      store.queue('private', 1999);
      store.record(notice('future'), 1000);
      store.queue('future', 6000);
      store.record(notice('archived'), 1000);
      store.queue('archived', 1);
      store.archive('archived', 1001);
      store.record(notice('resolved', { kind: 'approval', permId: 'done' }), 1000);
      store.queue('resolved', 1);
      store.resolvePermission('done', 'allowed', 1001);
      const visible = vi.fn((filename: string) => filename !== 'private.md');
      store.setInboxReadPolicy(() => visible);
      expect(store.due(5000).map((item) => item.id)).toEqual(
        Array.from({ length: 25 }, (_, i) => `due-${i}`),
      );
      expect(visible).toHaveBeenCalledTimes(26);
      expect(
        visible.mock.calls.some(
          ([filename]) => filename === 'future.md' || filename.startsWith('history-'),
        ),
      ).toBe(false);
      store.setInboxReadPolicy(() => () => false);
      expect(store.due(5000)).toEqual([]);
      expect(store.attempts('due-0')).toBe(0);
    } finally {
      close();
    }
  });

  it('counts actionable visible records without materializing a feed and refreshes privacy', () => {
    const { store, close } = setup();
    try {
      seedHistory(store);
      for (const id of ['public', 'private', 'archived', 'resolved']) {
        store.record(notice(id, { inbox: alert }), 1000);
      }
      store.resolveInbox('archived', 1500);
      store.archive('archived', 1500);
      store.resolveInbox('resolved', 1500);
      store.record(notice('read-approval', { kind: 'approval', permId: 'live' }), 1000);
      store.markRead('read-approval', 1500);
      store.record(notice('seat-access:expired', { kind: 'approval', expiresAt: 2000 }), 1000);
      let allowPrivate = false;
      const visible = vi.fn((filename: string) => allowPrivate || filename !== 'private.md');
      store.setInboxReadPolicy(() => visible);
      expect(store.needsAttentionCount(5000)).toBe(2);
      expect(visible).toHaveBeenCalledTimes(3);
      expect(store.needsAttentionCount(5000)).toBe(store.feed('needs', 5000).needsYou);
      allowPrivate = true;
      expect(store.needsAttentionCount(5000)).toBe(3);
      store.setInboxReadPolicy(() => {
        throw new Error('policy unavailable');
      });
      expect(store.needsAttentionCount(5000)).toBe(0);
      expect(store.get('seat-access:expired')).toBeUndefined();
      store.setInboxReadPolicy(() => () => true);
      expect(store.get('seat-access:expired')?.resolution).toBe('expired');
    } finally {
      close();
    }
  });
});

it('uses the count-only path for changed, registration and push badges', async () => {
  const store = new NotificationStore(':memory:');
  const push = vi.fn().mockResolvedValue({ status: 'accepted', acceptedDevices: [] });
  const badge = vi.fn().mockResolvedValue('accepted');
  const center = new NotificationCenter(store, {
    push,
    badge,
    changed: () => {},
    configured: () => true,
    devices: () => 1,
    sessionTitle: () => undefined,
  });
  try {
    const feed = vi.spyOn(store, 'feed').mockImplementation(() => {
      throw new Error('feed must not be materialized');
    });
    center.changed();
    await center.syncBadge();
    store.record(notice('push', { kind: 'test' }));
    store.queue('push', Date.now());
    await center.flush();
    expect(feed).not.toHaveBeenCalled();
    expect(badge).toHaveBeenLastCalledWith(0);
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ badge: 0 }));
  } finally {
    center.close();
    store.close();
  }
});
