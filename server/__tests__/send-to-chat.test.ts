import { describe, it, expect, afterEach, vi } from 'vitest';
import { registry, sendToChat, interruptChat } from '../chat.js';
import type { SessionTransport } from '@mitzo/harness';

function mockTransport(open = true): SessionTransport & { _sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  return {
    send: vi.fn((data: Record<string, unknown>) => sent.push(data)),
    isOpen: () => open,
    _sent: sent,
  };
}

describe('sendToChat emits user_message via transport', () => {
  const CLIENT_ID = 'test-client-send';

  afterEach(() => {
    registry.abort(CLIENT_ID);
  });

  it('sends a user_message event after persisting to event store', () => {
    const transport = mockTransport();
    const pushSpy = vi.fn();

    registry.register(CLIENT_ID, {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
    });

    const session = registry.get(CLIENT_ID)!;
    session.sessionId = 'sess-123';
    session.inputQueue = { push: pushSpy, close: vi.fn() };

    const result = sendToChat(CLIENT_ID, 'Hello from user');
    expect(result).toBe(true);

    // Should have sent a user_message via transport
    const userMsgEvents = transport._sent.filter(
      (m: Record<string, unknown>) => m.type === 'user_message',
    );
    expect(userMsgEvents).toHaveLength(1);
    expect(userMsgEvents[0]).toMatchObject({
      type: 'user_message',
      text: 'Hello from user',
    });
    // Falls back to server-generated umsg-* when no clientMsgId provided
    expect((userMsgEvents[0] as Record<string, unknown>).messageId).toMatch(/^umsg-/);
  });

  it('uses clientMsgId as messageId when provided', () => {
    const transport = mockTransport();
    const pushSpy = vi.fn();

    registry.register(CLIENT_ID, {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
    });

    const session = registry.get(CLIENT_ID)!;
    session.sessionId = 'sess-client-id';
    session.inputQueue = { push: pushSpy, close: vi.fn() };

    const result = sendToChat(CLIENT_ID, 'Hello', undefined, undefined, 'user-1234-abc');
    expect(result).toBe(true);

    const userMsgEvents = transport._sent.filter(
      (m: Record<string, unknown>) => m.type === 'user_message',
    );
    expect(userMsgEvents).toHaveLength(1);
    expect((userMsgEvents[0] as Record<string, unknown>).messageId).toBe('user-1234-abc');
  });

  it('does not crash when transport is not open', () => {
    const transport = mockTransport(false);
    const pushSpy = vi.fn();

    registry.register(CLIENT_ID, {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
    });

    const session = registry.get(CLIENT_ID)!;
    session.sessionId = 'sess-456';
    session.inputQueue = { push: pushSpy, close: vi.fn() };

    const result = sendToChat(CLIENT_ID, 'Hello');
    expect(result).toBe(true);
    // send() guards on isOpen(), so no message should be sent
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('still pushes to inputQueue even when transport send happens', () => {
    const transport = mockTransport();
    const pushSpy = vi.fn();

    registry.register(CLIENT_ID, {
      transport,
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

describe('interruptChat emits user_message via transport', () => {
  const CLIENT_ID = 'test-client-interrupt';

  afterEach(() => {
    registry.abort(CLIENT_ID);
  });

  it('sends a user_message event after persisting', async () => {
    const transport = mockTransport();
    const pushSpy = vi.fn();

    registry.register(CLIENT_ID, {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
    });

    const session = registry.get(CLIENT_ID)!;
    session.sessionId = 'sess-int-1';
    session.inputQueue = { push: pushSpy, close: vi.fn() };
    session.queryInstance = {
      interrupt: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      stopTask: vi.fn().mockResolvedValue(undefined),
    };

    const result = await interruptChat(CLIENT_ID, 'Urgent message');
    expect(result).toBe(true);

    const userMsgEvents = transport._sent.filter(
      (m: Record<string, unknown>) => m.type === 'user_message',
    );
    expect(userMsgEvents).toHaveLength(1);
    expect(userMsgEvents[0]).toMatchObject({
      type: 'user_message',
      text: 'Urgent message',
    });
  });

  it('uses clientMsgId as messageId when provided', async () => {
    const transport = mockTransport();
    const pushSpy = vi.fn();

    registry.register(CLIENT_ID, {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
    });

    const session = registry.get(CLIENT_ID)!;
    session.sessionId = 'sess-int-2';
    session.inputQueue = { push: pushSpy, close: vi.fn() };
    session.queryInstance = {
      interrupt: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      stopTask: vi.fn().mockResolvedValue(undefined),
    };

    const result = await interruptChat(CLIENT_ID, 'Urgent', undefined, undefined, 'user-5678-def');
    expect(result).toBe(true);

    const userMsgEvents = transport._sent.filter(
      (m: Record<string, unknown>) => m.type === 'user_message',
    );
    expect(userMsgEvents).toHaveLength(1);
    expect((userMsgEvents[0] as Record<string, unknown>).messageId).toBe('user-5678-def');
  });

  it('calls stopTask for active subagent tasks before interrupt', async () => {
    const transport = mockTransport();
    const pushSpy = vi.fn();
    const stopTaskSpy = vi.fn().mockResolvedValue(undefined);
    const interruptSpy = vi.fn().mockResolvedValue(undefined);

    registry.register(CLIENT_ID, {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
    });

    const session = registry.get(CLIENT_ID)!;
    session.sessionId = 'sess-int-3';
    session.inputQueue = { push: pushSpy, close: vi.fn() };
    session.queryInstance = {
      interrupt: interruptSpy,
      close: vi.fn(),
      stopTask: stopTaskSpy,
    };
    session.activeTaskIds.set('task-abc', 'tool-1');
    session.activeTaskIds.set('task-def', 'tool-2');

    await interruptChat(CLIENT_ID, 'Stop everything');

    expect(stopTaskSpy).toHaveBeenCalledTimes(2);
    expect(stopTaskSpy).toHaveBeenCalledWith('task-abc');
    expect(stopTaskSpy).toHaveBeenCalledWith('task-def');
    expect(interruptSpy).toHaveBeenCalledTimes(1);
  });
});
