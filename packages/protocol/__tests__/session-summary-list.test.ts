import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventStore } from '../src/event-store.js';

let store: EventStore;
beforeEach(() => {
  store = new EventStore(':memory:');
});
afterEach(() => store.close());

describe('bounded public summary metadata pages', () => {
  it('pages only registered visible summaries with stable tie ordering and bounded fields', () => {
    for (const [sessionId, updatedAt, summary] of [
      ['a', 10, 'a'.repeat(5000)],
      ['b', 10, 'Public title'],
      ['c', 9, 'Older title'],
    ] as const) {
      store.upsertSession({ sessionId, updatedAt, summary, conversationSource: 'mitzo' });
    }
    store.upsertSession({
      sessionId: 'hidden',
      summary: 'hidden title',
      updatedAt: 20,
      conversationSource: 'mitzo',
    });
    store.hideSession('hidden');
    store.upsertSession({
      sessionId: 'sdk-only',
      summary: 'unregistered',
      updatedAt: 30,
      conversationSource: 'legacy',
      isActive: false,
    });
    store.append('a', 'block_delta', { blockType: 'thinking', delta: 'private reasoning' });
    // Restore the deterministic metadata timestamp changed by append.
    store.upsertSession({ sessionId: 'a', updatedAt: 10 });
    expect(store.listSessionSummaries(1, 0)).toEqual({
      sessions: [
        { sessionId: 'a', summary: 'a'.repeat(4096), summaryTruncated: true, updatedAt: 10 },
      ],
      hasMore: true,
    });
    expect(store.listSessionSummaries(1, 1)).toEqual({
      sessions: [
        { sessionId: 'b', summary: 'Public title', summaryTruncated: false, updatedAt: 10 },
      ],
      hasMore: true,
    });
    expect(store.listSessionSummaries(1, 2)).toEqual({
      sessions: [{ sessionId: 'c', summary: 'Older title', summaryTruncated: false, updatedAt: 9 }],
      hasMore: false,
    });
  });

  it('rejects unbounded or malformed pagination requests', () => {
    for (const [limit, offset] of [
      [0, 0],
      [101, 0],
      [1.5, 0],
      [1, -1],
      [1, 100001],
      [1, NaN],
    ]) {
      expect(() => store.listSessionSummaries(limit, offset)).toThrow(/pagination/);
    }
  });
});
