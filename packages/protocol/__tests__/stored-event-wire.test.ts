import { describe, expect, it } from 'vitest';
import { storedEventToClientMessage, type StoredEvent } from '../src/index.js';

const provenance = {
  seatId: 'reviewer',
  configRevision: 1,
  accountProfileRevision: 'account-rev-1',
  seatProfileRevision: 'seat-rev-1',
  contextGrantRevision: 1,
  authorityGrantRevision: 1,
  isolationDomainId: 'work',
  isolationDomainRevision: 1,
};

describe('stored Symposium event wire envelope', () => {
  it('carries durable seat attribution and sequence alongside original content', () => {
    const event: StoredEvent = {
      seq: 7,
      sessionId: 'conversation',
      type: 'block_delta',
      payload: { type: 'block_delta', messageId: 'm1', blockId: 'b0', delta: 'hello' },
      seatId: 'reviewer',
      symposiumProvenance: provenance,
      createdAt: 100,
    };
    expect(storedEventToClientMessage(event)).toEqual({
      type: 'block_delta',
      messageId: 'm1',
      blockId: 'b0',
      delta: 'hello',
      seq: 7,
      seatId: 'reviewer',
      symposiumProvenance: provenance,
    });
  });

  it('ignores forged attribution in payload and preserves the durable reconnect predecessor', () => {
    const event: StoredEvent & { prevSessionSeq: number } = {
      seq: 8,
      prevSessionSeq: 7,
      sessionId: 'conversation',
      type: 'block_delta',
      payload: {
        type: 'block_delta',
        seatId: 'forged',
        symposiumProvenance: { seatId: 'forged' },
        seq: 999,
        prevSessionSeq: 999,
      },
      seatId: 'reviewer',
      symposiumProvenance: provenance,
      createdAt: 101,
    };
    expect(storedEventToClientMessage(event)).toMatchObject({
      seq: 8,
      prevSessionSeq: 7,
      seatId: 'reviewer',
      symposiumProvenance: provenance,
    });
  });

  it('rejects a corrupted durable seat/provenance pair', () => {
    expect(() =>
      storedEventToClientMessage({
        seq: 9,
        sessionId: 'conversation',
        type: 'message_start',
        payload: { type: 'message_start' },
        seatId: 'architect',
        symposiumProvenance: provenance,
        createdAt: 102,
      }),
    ).toThrow(/seat.*provenance/i);
  });
});
