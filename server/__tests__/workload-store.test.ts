import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { WorkloadStore } from '../workload-store.js';
import type { WorkSignal } from '../workload-store.js';

const TEST_DIR = join(tmpdir(), `mitzo-workload-test-${process.pid}`);

let db: Database.Database;
let store: WorkloadStore;

function makeSignal(overrides?: Partial<WorkSignal>): WorkSignal {
  return {
    sourceType: 'manual',
    sourceId: `test-${Date.now()}-${Math.random()}`,
    url: 'https://example.com',
    title: 'Test item',
    snippet: 'A test work signal',
    author: 'test-user',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  db = new Database(join(TEST_DIR, `workload-${Date.now()}.db`));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  store = new WorkloadStore(db);
});

afterEach(() => {
  store.close();
  db.close();
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('WorkloadStore', () => {
  describe('ingest', () => {
    it('creates a new item from a signal', () => {
      const signal = makeSignal({ title: 'Review PR #42' });
      const { item, created } = store.ingest(signal);

      expect(created).toBe(true);
      expect(item.title).toBe('Review PR #42');
      expect(item.status).toBe('active');
      expect(item.sources).toHaveLength(1);
      expect(item.sources[0].sourceType).toBe('manual');
      expect(item.sources[0].sourceId).toBe(signal.sourceId);
    });

    it('deduplicates by sourceType + sourceId', () => {
      const signal = makeSignal({ sourceType: 'jira', sourceId: 'RHAIENG-100' });
      const first = store.ingest(signal);
      const second = store.ingest(signal);

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(first.item.id).toBe(second.item.id);
    });

    it('applies urgency hint', () => {
      const signal = makeSignal({ urgencyHint: 0.8 });
      const { item } = store.ingest(signal);
      expect(item.urgency).toBeGreaterThanOrEqual(0.8);
    });

    it('applies age boost for old signals', () => {
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 10);
      const signal = makeSignal({
        timestamp: oldDate.toISOString(),
        urgencyHint: 0.3,
      });
      const { item } = store.ingest(signal);
      // Age > 7 days = +0.1 boost
      expect(item.urgency).toBeGreaterThanOrEqual(0.4);
    });

    it('stores context hints', () => {
      const signal = makeSignal({
        contextHints: {
          repos: ['dimakis/mgmt'],
          jiraKeys: ['RHAIENG-100'],
          keywords: ['auth', 'refactor'],
        },
      });
      const { item } = store.ingest(signal);
      expect(item.contextHints.repos).toEqual(['dimakis/mgmt']);
      expect(item.contextHints.jiraKeys).toEqual(['RHAIENG-100']);
      expect(item.contextHints.keywords).toEqual(['auth', 'refactor']);
    });

    it('respects profile from signal', () => {
      const signal = makeSignal({ profile: 'work' });
      const { item } = store.ingest(signal);
      expect(item.profile).toBe('work');
    });

    it('defaults profile to "default"', () => {
      const signal = makeSignal();
      const { item } = store.ingest(signal);
      expect(item.profile).toBe('default');
    });
  });

  describe('ingestBatch', () => {
    it('ingests multiple signals in a transaction', () => {
      const signals = [
        makeSignal({ title: 'Item 1', sourceId: 'batch-1' }),
        makeSignal({ title: 'Item 2', sourceId: 'batch-2' }),
        makeSignal({ title: 'Item 3', sourceId: 'batch-3' }),
      ];
      const result = store.ingestBatch(signals);
      expect(result.items).toHaveLength(3);
      expect(result.created).toBe(3);
    });

    it('deduplicates within batch', () => {
      const signals = [
        makeSignal({ sourceId: 'same-id', title: 'First' }),
        makeSignal({ sourceId: 'same-id', title: 'Duplicate' }),
      ];
      const result = store.ingestBatch(signals);
      expect(result.items).toHaveLength(2);
      expect(result.created).toBe(1); // second is a dedup
    });
  });

  describe('list', () => {
    it('returns items sorted by starred then urgency', () => {
      store.ingest(makeSignal({ title: 'Low', urgencyHint: 0.1, sourceId: 'low' }));
      store.ingest(makeSignal({ title: 'High', urgencyHint: 0.9, sourceId: 'high' }));

      const items = store.list();
      expect(items).toHaveLength(2);
      expect(items[0].title).toBe('High');
      expect(items[1].title).toBe('Low');
    });

    it('filters by profile', () => {
      store.ingest(makeSignal({ profile: 'work', sourceId: 'w1' }));
      store.ingest(makeSignal({ profile: 'personal', sourceId: 'p1' }));

      const work = store.list({ profile: 'work' });
      expect(work).toHaveLength(1);
      expect(work[0].profile).toBe('work');
    });

    it('filters by status', () => {
      const { item } = store.ingest(makeSignal({ sourceId: 'ack-me' }));
      store.update(item.id, { status: 'acknowledged' });
      store.ingest(makeSignal({ sourceId: 'active-one' }));

      const active = store.list({ status: 'active' });
      expect(active).toHaveLength(1);
    });

    it('filters by starred', () => {
      const { item } = store.ingest(makeSignal({ sourceId: 'star-me' }));
      store.update(item.id, { starred: true });
      store.ingest(makeSignal({ sourceId: 'unstarred' }));

      const starred = store.list({ starred: true });
      expect(starred).toHaveLength(1);
      expect(starred[0].starred).toBe(true);
    });
  });

  describe('update', () => {
    it('updates status', () => {
      const { item } = store.ingest(makeSignal());
      const updated = store.update(item.id, { status: 'acknowledged' });
      expect(updated?.status).toBe('acknowledged');
    });

    it('updates starred', () => {
      const { item } = store.ingest(makeSignal());
      const updated = store.update(item.id, { starred: true });
      expect(updated?.starred).toBe(true);
    });

    it('sets snoozed status when snoozedUntil is set', () => {
      const { item } = store.ingest(makeSignal());
      const updated = store.update(item.id, { snoozedUntil: '2026-05-01' });
      expect(updated?.status).toBe('snoozed');
      expect(updated?.snoozedUntil).toBe('2026-05-01');
    });

    it('merges context hints on update', () => {
      const { item } = store.ingest(
        makeSignal({ contextHints: { repos: ['repo-a'], keywords: ['old'] } }),
      );
      const updated = store.update(item.id, {
        contextHints: { repos: ['repo-b'], keywords: ['new'] },
      });
      expect(updated?.contextHints.repos).toEqual(['repo-a', 'repo-b']);
      expect(updated?.contextHints.keywords).toEqual(['old', 'new']);
    });

    it('returns null for non-existent item', () => {
      const result = store.update('nonexistent', { status: 'completed' });
      expect(result).toBeNull();
    });
  });

  describe('delete', () => {
    it('deletes an item and its sources', () => {
      const { item } = store.ingest(makeSignal());
      expect(store.delete(item.id)).toBe(true);
      expect(store.get(item.id)).toBeNull();
    });

    it('returns false for non-existent item', () => {
      expect(store.delete('nonexistent')).toBe(false);
    });
  });

  describe('setGoalId', () => {
    it('links item to goal and sets acknowledged', () => {
      const { item } = store.ingest(makeSignal());
      const updated = store.setGoalId(item.id, 'goal-123');
      expect(updated?.goalId).toBe('goal-123');
      expect(updated?.status).toBe('acknowledged');
    });
  });

  describe('completeByGoal', () => {
    it('completes items linked to a goal', () => {
      const { item } = store.ingest(makeSignal());
      store.setGoalId(item.id, 'goal-456');
      store.completeByGoal('goal-456');
      const completed = store.get(item.id);
      expect(completed?.status).toBe('completed');
    });
  });

  describe('unsnoozeDue', () => {
    it('unsnoozes items past their snooze date', () => {
      const { item } = store.ingest(makeSignal());
      store.update(item.id, { snoozedUntil: '2020-01-01' }); // past date
      const count = store.unsnoozeDue();
      expect(count).toBe(1);
      const updated = store.get(item.id);
      expect(updated?.status).toBe('active');
      expect(updated?.snoozedUntil).toBeNull();
    });
  });

  describe('profiles', () => {
    it('returns profile counts excluding completed', () => {
      store.ingest(makeSignal({ profile: 'work', sourceId: 'w1' }));
      store.ingest(makeSignal({ profile: 'work', sourceId: 'w2' }));
      store.ingest(makeSignal({ profile: 'personal', sourceId: 'p1' }));

      const profiles = store.profiles();
      expect(profiles).toEqual([
        { profile: 'work', count: 2 },
        { profile: 'personal', count: 1 },
      ]);
    });
  });
});
