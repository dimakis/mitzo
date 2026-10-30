import { expect, it, vi } from 'vitest';
import type { StoredEvent } from '@mitzo/protocol';
import { projectCompactions, readCompactionHistory } from '../compaction-history';

const event = (
  seq: number,
  type: string,
  createdAt: number,
  payload: Record<string, unknown>,
  sessionId = 's',
): StoredEvent => ({ seq, sessionId, type, createdAt, payload });
const usage = (seq: number, at: number, tokens: number, checkedAt = at, sessionId = 's') =>
  event(
    seq,
    'token_update',
    at,
    {
      agentContext: tokens,
      contextCeiling: 258400,
      turnIndex: 15,
      tokenLimits: { model: 'fixture-model', source: 'runtime', checkedAt, stale: false },
    },
    sessionId,
  );
const start = event(3, 'context_compaction', 2000, { id: 'c', phase: 'compacting', turnIndex: 15 });
const done = event(5, 'context_compaction', 394669, { id: 'c', phase: 'completed' });

it('retains start/end times and brackets compaction with fresh usage, not the stale completion echo', () => {
  const [record] = projectCompactions([
    usage(1, 1000, 185160),
    usage(2, 1996, 189054),
    start,
    done,
    usage(6, 394670, 189054, 1996),
    usage(7, 403152, 28549),
    usage(8, 410000, 30566),
  ]);
  expect(record).toMatchObject({
    startedAt: 2000,
    endedAt: 394669,
    observedAt: 394669,
    beforeTokens: null,
    afterTokens: null,
    usageBefore: {
      tokens: 189054,
      observedAt: 1996,
      model: 'fixture-model',
      contextCeiling: 258400,
    },
    usageAfter: {
      tokens: 28549,
      observedAt: 403152,
      model: 'fixture-model',
      contextCeiling: 258400,
    },
    summary: null,
    condensedRange: null,
  });
});

it('does not borrow context across conversations, turns or a later compaction', () => {
  const next = event(6, 'context_compaction', 400000, {
    id: 'next',
    phase: 'compacting',
    turnIndex: 16,
  });
  const records = projectCompactions([
    usage(1, 1000, 99, 1000, 'other'),
    start,
    done,
    next,
    { ...usage(7, 410000, 42), payload: { ...usage(7, 410000, 42).payload, turnIndex: 16 } },
  ]);
  expect(records[0].usageBefore).toBeNull();
  expect(records[0].usageAfter).toBeNull();
  expect(records[1].usageAfter).toBeNull();
});

it('keeps interrupted, missing-start and unproven fresh usage explicit', () => {
  const records = projectCompactions([
    usage(1, 1000, 50),
    start,
    event(4, 'context_compaction', 3000, { id: 'c', phase: 'interrupted' }),
    usage(5, 4000, 20),
    event(6, 'context_compaction', 5000, { id: 'only-done', phase: 'completed' }),
    event(7, 'token_update', 6000, { agentContext: 10 }),
  ]);
  expect(records[0]).toMatchObject({ startedAt: 2000, endedAt: 3000, usageAfter: null });
  expect(records[1]).toMatchObject({
    startedAt: null,
    endedAt: 5000,
    usageBefore: null,
    usageAfter: null,
  });
});

it('reads bounded lifecycle and usage history without loading the transcript', () => {
  const store = {
    getEventsOfType: vi.fn((_id: string, type: string) =>
      type === 'context_compaction'
        ? [done, start]
        : [usage(7, 403152, 28549), usage(2, 1996, 189054)],
    ),
  };
  const result = readCompactionHistory(store, 's');
  expect(store.getEventsOfType.mock.calls).toEqual([
    ['s', 'context_compaction', 513],
    ['s', 'token_update', 1024],
  ]);
  expect(result.records[0].usageAfter?.tokens).toBe(28549);
  expect(result.truncated).toBe(false);
});

it('does not attribute fresh usage to a compaction whose turn identity is missing', () => {
  const records = projectCompactions([
    event(1, 'context_compaction', 2000, { id: 'legacy', phase: 'compacting' }),
    event(2, 'context_compaction', 3000, { id: 'legacy', phase: 'completed' }),
    usage(3, 4000, 20),
  ]);
  expect(records[0].usageAfter).toBeNull();
});
