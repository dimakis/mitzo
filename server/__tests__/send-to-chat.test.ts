import { describe, it, expect, afterEach, vi } from 'vitest';
import { registry, sendToChat, interruptChat } from '../chat.js';

function mockWs() {
  const sent: unknown[] = [];
  return {
    readyState: 1,
    OPEN: 1,
    send: vi.fn((data: string) => sent.push(JSON.parse(data))),
    on: vi.fn(),
    removeListener: vi.fn(),
    _sent: sent,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('sendToChat emits user_message via WebSocket', () => {
  const CLIENT_ID = 'test-client-send';

  afterEach(() => {
    registry.abort(CLIENT_ID);
  });

  it('sends a user_message WS event after persisting to event store', () => {
    const ws = mockWs();
    const pushSpy = vi.fn();

    registry.register(CLIENT_ID, {
      ws,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
    });

    const session = registry.get(CLIENT_ID)!;
    session.sessionId = 'sess-123';
    session.inputQueue = { push: pushSpy, close: vi.fn() };

    const result = sendToChat(CLIENT_ID, 'Hello from user');
    expect(result).toBe(true);

    // Should have sent a user_message via WebSocket
    const userMsgEvents = ws._sent.filter(
      (m: Record<string, unknown>) => m.type === 'user_message',
    );
    expect(userMsgEvents).toHaveLength(1);
    expect(userMsgEvents[0]).toMatchObject({
      type: 'user_message',
      text: 'Hello from user',
    });
    expect(userMsgEvents[0].messageId).toMatch(/^umsg-/);
  });

  it('does not crash when ws is not OPEN', () => {
    const ws = mockWs();
    ws.readyState = 3; // CLOSED
    const pushSpy = vi.fn();

    registry.register(CLIENT_ID, {
      ws,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
    });

    const session = registry.get(CLIENT_ID)!;
    session.sessionId = 'sess-456';
    session.inputQueue = { push: pushSpy, close: vi.fn() };

    const result = sendToChat(CLIENT_ID, 'Hello');
    expect(result).toBe(true);
    // send() guards on readyState, so no WS message should be sent
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('still pushes to inputQueue even when WS emit happens', () => {
    const ws = mockWs();
    const pushSpy = vi.fn();

    registry.register(CLIENT_ID, {
      ws,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
    });

    const session = registry.get(CLIENT_ID)!;
    session.sessionId = 'sess-789';
    session.inputQueue = { push: pushSpy, close: vi.fn() };

    sendToChat(CLIENT_ID, 'Follow-up');
    expect(pushSpy).toHaveBeenCalledTimes(1);
  });
});

describe('interruptChat emits user_message via WebSocket', () => {
  const CLIENT_ID = 'test-client-interrupt';

  afterEach(() => {
    registry.abort(CLIENT_ID);
  });

  it('sends a user_message WS event after persisting', async () => {
    const ws = mockWs();
    const pushSpy = vi.fn();

    registry.register(CLIENT_ID, {
      ws,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
    });

    const session = registry.get(CLIENT_ID)!;
    session.sessionId = 'sess-int-1';
    session.inputQueue = { push: pushSpy, close: vi.fn() };
    session.queryInstance = { interrupt: vi.fn().mockResolvedValue(undefined), close: vi.fn() };

    const result = await interruptChat(CLIENT_ID, 'Urgent message');
    expect(result).toBe(true);

    const userMsgEvents = ws._sent.filter(
      (m: Record<string, unknown>) => m.type === 'user_message',
    );
    expect(userMsgEvents).toHaveLength(1);
    expect(userMsgEvents[0]).toMatchObject({
      type: 'user_message',
      text: 'Urgent message',
    });
  });
});
