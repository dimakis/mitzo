import { expect, it, vi } from 'vitest';
import { createQueuedMessageReceiptHandler } from '../queued-message-receipt.js';
import type { Request, Response } from 'express';
it('checks only exact same-chat receipt evidence without replaying an interrupt', () => {
  const getSession = vi.fn(() => ({ symposiumConfig: null, sessionType: 'chat' })),
    hasUserMessage = vi.fn(
      (sessionId: string, messageId: string) => sessionId === 'chat' && messageId === 'received',
    );
  const res = { json: vi.fn(), status: vi.fn() };
  res.status.mockReturnValue(res);
  const read = createQueuedMessageReceiptHandler({ getSession, hasUserMessage });
  for (const [id, messageId, received] of [
    ['chat', 'received', true],
    ['chat', 'missing', false],
    ['other', 'received', false],
  ] as const) {
    read({ params: { id, messageId } } as unknown as Request, res as unknown as Response, vi.fn());
    expect(res.json).toHaveBeenLastCalledWith({ messageId, received });
  }
  expect(hasUserMessage).toHaveBeenCalledTimes(3);
});
it('does not disclose receipt evidence for missing or Symposium conversations', () => {
  const hasUserMessage = vi.fn();
  const res = { json: vi.fn(), status: vi.fn() };
  res.status.mockReturnValue(res);
  for (const session of [
    undefined,
    { sessionId: 'symposium', symposiumConfig: {} },
    { sessionId: 'symposium', sessionType: 'symposium' },
  ]) {
    const read = createQueuedMessageReceiptHandler({
      getSession: () => session,
      hasUserMessage,
    });
    read(
      { params: { id: 'hidden', messageId: 'original' } } as unknown as Request,
      res as unknown as Response,
      vi.fn(),
    );
    expect(res.status).toHaveBeenLastCalledWith(404);
  }
  expect(hasUserMessage).not.toHaveBeenCalled();
});
