import { expect, it } from 'vitest';
import { projectCompactions } from '../compaction-history';
import type { StoredEvent } from '@mitzo/protocol';
const event = (seq: number, payload: Record<string, unknown>): StoredEvent => ({
  seq,
  sessionId: 's',
  createdAt: seq * 100,
  type: 'context_compaction',
  payload,
});
it('updates a compaction at its original position and never invents a condensed range', () => {
  const records = projectCompactions([
    event(5, { id: 'c', phase: 'compacting', afterMessageId: 'a12', turnIndex: 12 }),
    event(9, { id: 'c', phase: 'completed', beforeTokens: 112000, afterTokens: 48000 }),
  ]);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    id: 'c',
    seq: 5,
    phase: 'completed',
    afterMessageId: 'a12',
    beforeTokens: 112000,
    afterTokens: 48000,
  });
  expect(records[0].condensedRange).toBeNull();
  expect(records[0].summary).toBeNull();
});
it('retains independent compactions and ignores malformed evidence', () => {
  expect(
    projectCompactions([
      event(1, { id: 'a', phase: 'completed' }),
      event(2, { id: 'b', phase: 'compacting' }),
      event(3, { id: 'bad', phase: 'invented' }),
    ]).map((record) => record.id),
  ).toEqual(['a', 'b']);
});
