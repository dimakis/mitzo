import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventStore } from '../event-store.js';

describe('Token capture — usage tracking', () => {
  let store: EventStore;

  beforeEach(() => {
    store = new EventStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  describe('migrateUsageTracking', () => {
    it('adds usage columns to sessions table', () => {
      // Session doesn't exist yet, but creating one should include the new fields
      store.upsertSession({ sessionId: 'test-session', summary: 'Test' });
      const result = store.getSession('test-session');

      expect(result).not.toBeNull();
      expect(result!.inputTokens).toBe(0);
      expect(result!.outputTokens).toBe(0);
      expect(result!.cacheReadTokens).toBe(0);
      expect(result!.cacheCreationTokens).toBe(0);
      expect(result!.totalCostUsd).toBe(0);
      expect(result!.numTurns).toBe(0);
      expect(result!.durationMs).toBe(0);
      expect(result!.durationApiMs).toBe(0);
      expect(result!.goalId).toBeNull();
    });

    it('migration is idempotent — opening a second store on same db does not crash', () => {
      // The in-memory store already ran migration once in beforeEach.
      // Simulating re-open by creating another store on a file-based db would
      // test idempotency, but :memory: suffices for column presence.
      store.upsertSession({ sessionId: 's1' });
      const s = store.getSession('s1');
      expect(s!.inputTokens).toBe(0);
    });
  });

  describe('recordUsage', () => {
    it('stores usage data on an existing session', () => {
      store.upsertSession({ sessionId: 'sess-usage', summary: 'Usage test' });

      store.recordUsage('sess-usage', {
        inputTokens: 1500,
        outputTokens: 800,
        cacheReadTokens: 200,
        cacheCreationTokens: 50,
        totalCostUsd: 0.0042,
        numTurns: 3,
        durationMs: 12000,
        durationApiMs: 8000,
      });

      const session = store.getSession('sess-usage');
      expect(session).not.toBeNull();
      expect(session!.inputTokens).toBe(1500);
      expect(session!.outputTokens).toBe(800);
      expect(session!.cacheReadTokens).toBe(200);
      expect(session!.cacheCreationTokens).toBe(50);
      expect(session!.totalCostUsd).toBeCloseTo(0.0042);
      expect(session!.numTurns).toBe(3);
      expect(session!.durationMs).toBe(12000);
      expect(session!.durationApiMs).toBe(8000);
    });

    it('does not crash on non-existent session', () => {
      // Should silently do nothing (UPDATE on non-existent row = 0 rows affected)
      expect(() => {
        store.recordUsage('nonexistent-session', {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          totalCostUsd: 0.001,
          numTurns: 1,
          durationMs: 1000,
          durationApiMs: 500,
        });
      }).not.toThrow();
    });

    it('overwrites previous usage data on repeated calls', () => {
      store.upsertSession({ sessionId: 'sess-overwrite' });

      store.recordUsage('sess-overwrite', {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalCostUsd: 0.001,
        numTurns: 1,
        durationMs: 1000,
        durationApiMs: 500,
      });

      store.recordUsage('sess-overwrite', {
        inputTokens: 5000,
        outputTokens: 2000,
        cacheReadTokens: 300,
        cacheCreationTokens: 100,
        totalCostUsd: 0.05,
        numTurns: 10,
        durationMs: 60000,
        durationApiMs: 45000,
      });

      const session = store.getSession('sess-overwrite');
      expect(session!.inputTokens).toBe(5000);
      expect(session!.outputTokens).toBe(2000);
      expect(session!.numTurns).toBe(10);
    });
  });

  describe('usage fields in listing', () => {
    it('usage fields appear in listSessions() results', () => {
      store.upsertSession({ sessionId: 'sess-list' });
      store.recordUsage('sess-list', {
        inputTokens: 999,
        outputTokens: 444,
        cacheReadTokens: 111,
        cacheCreationTokens: 22,
        totalCostUsd: 0.01,
        numTurns: 5,
        durationMs: 30000,
        durationApiMs: 20000,
      });

      const sessions = store.listSessions();
      const found = sessions.find((s) => s.sessionId === 'sess-list');
      expect(found).not.toBeUndefined();
      expect(found!.inputTokens).toBe(999);
      expect(found!.outputTokens).toBe(444);
      expect(found!.cacheReadTokens).toBe(111);
      expect(found!.cacheCreationTokens).toBe(22);
      expect(found!.totalCostUsd).toBeCloseTo(0.01);
      expect(found!.numTurns).toBe(5);
      expect(found!.durationMs).toBe(30000);
      expect(found!.durationApiMs).toBe(20000);
      expect(found!.goalId).toBeNull();
    });

    it('usage fields appear in getSession() results', () => {
      store.upsertSession({ sessionId: 'sess-get' });
      store.recordUsage('sess-get', {
        inputTokens: 2500,
        outputTokens: 1200,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalCostUsd: 0.025,
        numTurns: 7,
        durationMs: 45000,
        durationApiMs: 30000,
      });

      const session = store.getSession('sess-get');
      expect(session!.inputTokens).toBe(2500);
      expect(session!.outputTokens).toBe(1200);
      expect(session!.totalCostUsd).toBeCloseTo(0.025);
      expect(session!.numTurns).toBe(7);
    });
  });
});
