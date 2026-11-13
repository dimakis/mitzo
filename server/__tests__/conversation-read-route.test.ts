import { expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { EventStore } from '../event-store.js';
import { createConversationReadHandlers } from '../conversation-read-route.js';

it('projects and updates the real store through a bounded, validated metadata handler', () => {
  const store = new EventStore(':memory:');
  try {
    store.upsertSession({ sessionId: 'chat', conversationSource: 'mitzo' });
    const broadcast = vi.fn(),
      diagnostic = vi.fn();
    const handlers = createConversationReadHandlers(store, broadcast, diagnostic);
    const invoke = (method: 'get' | 'put', body?: unknown, id = 'chat') => {
      const result = { status: 200, body: undefined as unknown };
      const response = {
        status(code: number) {
          result.status = code;
          return this;
        },
        json(body: unknown) {
          result.body = body;
        },
      };
      handlers[method]({ params: { id }, body } as Request<{ id: string }>, response as Response);
      return result;
    };
    expect(invoke('get').body).toMatchObject({ latestReplySeq: 0, revision: 0 });
    expect(invoke('put', { markedUnread: true, expectedRevision: 0 }).status).toBe(200);
    expect(broadcast).toHaveBeenCalledOnce();
    expect(invoke('put', { readReplySeq: 0, expectedRevision: 0 }).status).toBe(409);
    expect(invoke('put', { readReplySeq: 'all' }).status).toBe(400);
    expect(invoke('put', { readReplySeq: 900, expectedRevision: 1 }).status).toBe(400);
    expect(invoke('put', { markedUnread: true, expectedRevision: 0 }, 'absent').status).toBe(404);
    vi.spyOn(store, 'getSessionReadState').mockImplementation(() => {
      throw Error('private SQL failure');
    });
    const failure = invoke('get');
    expect(failure.status).toBe(503);
    expect(JSON.stringify(failure.body)).not.toContain('private SQL');
    expect(diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'conversation_read_failed', sessionId: 'chat' }),
      expect.any(Error),
    );
  } finally {
    store.close();
  }
});
