import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eventStore, registry, sendToChat, interruptChat } from '../chat.js';
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
  const tempDirs: string[] = [];

  afterEach(() => {
    registry.abort(CLIENT_ID);
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('sends a user_message event after persisting to event store', async () => {
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

    const result = await sendToChat(CLIENT_ID, 'Hello from user');
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
    session.sessionId = `sess-client-id-${Date.now()}`;
    session.inputQueue = { push: pushSpy, close: vi.fn() };

    const clientMsgId = `user-${Date.now()}-abc`;
    const result = await sendToChat(CLIENT_ID, 'Hello', undefined, undefined, clientMsgId);
    expect(result).toBe(true);

    const userMsgEvents = transport._sent.filter(
      (m: Record<string, unknown>) => m.type === 'user_message',
    );
    expect(userMsgEvents).toHaveLength(1);
    expect((userMsgEvents[0] as Record<string, unknown>).messageId).toBe(clientMsgId);
  });

  it('persists and echoes image previews and context block names', async () => {
    const transport = mockTransport();
    const sessionId = `sess-sources-${Date.now()}`;
    registry.register(CLIENT_ID, {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
    });
    const session = registry.get(CLIENT_ID)!;
    session.sessionId = sessionId;
    session.cwd = mkdtempSync(join(tmpdir(), 'mitzo-send-sources-'));
    tempDirs.push(session.cwd);
    session.inputQueue = { push: vi.fn(), close: vi.fn() };

    expect(
      await sendToChat(
        CLIENT_ID,
        'Inspect this',
        [{ data: 'cHJldmlldw==', mediaType: 'image/png' }],
        ['constitution'],
        'user-with-sources',
      ),
    ).toBe(true);

    const expectedSources = {
      images: ['data:image/png;base64,cHJldmlldw=='],
      contextBlocks: ['constitution'],
    };
    expect(transport._sent.find((message) => message.type === 'user_message')).toMatchObject(
      expectedSources,
    );
    expect(
      eventStore.getSessionEvents(sessionId).find((event) => event.type === 'user_message')
        ?.payload,
    ).toMatchObject(expectedSources);
  });

  it('does not crash when transport is not open', async () => {
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

    const result = await sendToChat(CLIENT_ID, 'Hello');
    expect(result).toBe(true);
    // send() guards on isOpen(), so no message should be sent
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('skips duplicate when same clientMsgId is sent twice', async () => {
    const transport = mockTransport();
    const pushSpy = vi.fn();

    registry.register(CLIENT_ID, {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
    });

    const session = registry.get(CLIENT_ID)!;
    session.sessionId = `sess-dedup-${Date.now()}`;
    session.inputQueue = { push: pushSpy, close: vi.fn() };

    // First send — should succeed
    await expect(
      sendToChat(CLIENT_ID, 'Hello', undefined, undefined, 'user-dedup-1'),
    ).resolves.toBe(true);
    expect(pushSpy).toHaveBeenCalledTimes(1);

    // Second send with same clientMsgId — should be silently deduplicated
    const result = await sendToChat(CLIENT_ID, 'Hello', undefined, undefined, 'user-dedup-1');
    expect(result).toBe(true);
    // inputQueue should NOT get a second push
    expect(pushSpy).toHaveBeenCalledTimes(1);
    // transport should only have ONE user_message echo
    const userMsgs = transport._sent.filter(
      (m: Record<string, unknown>) => m.type === 'user_message',
    );
    expect(userMsgs).toHaveLength(1);
  });

  it('still pushes to inputQueue even when transport send happens', async () => {
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

    await sendToChat(CLIENT_ID, 'Follow-up');
    expect(pushSpy).toHaveBeenCalledTimes(1);
  });

  it('sends echo without sessionId when session.sessionId is falsy', async () => {
    const transport = mockTransport();
    const pushSpy = vi.fn();

    registry.register(CLIENT_ID, {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
    });

    const session = registry.get(CLIENT_ID)!;
    // Deliberately leave sessionId unset (falsy)
    session.inputQueue = { push: pushSpy, close: vi.fn() };

    const result = await sendToChat(CLIENT_ID, 'Before session resolved');
    expect(result).toBe(true);

    const userMsgs = transport._sent.filter(
      (m: Record<string, unknown>) => m.type === 'user_message',
    );
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0]).not.toHaveProperty('sessionId');
    expect(pushSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects an active Anthropic model switch without persisting or sending the message', async () => {
    const transport = mockTransport();
    const pushSpy = vi.fn();
    const sessionId = `sess-anthropic-model-${Date.now()}`;
    registry.register(CLIENT_ID, {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
    });

    const session = registry.get(CLIENT_ID)!;
    session.sessionId = sessionId;
    session.model = 'claude-sonnet-4-6';
    session.inputQueue = { push: pushSpy, close: vi.fn() };
    eventStore.upsertSession({ sessionId, selectedModel: session.model });

    expect(
      await sendToChat(
        CLIENT_ID,
        'Use the other model',
        undefined,
        undefined,
        'user-anthropic-model',
        'claude-opus-4-6',
      ),
    ).toBe(false);
    expect(pushSpy).not.toHaveBeenCalled();
    expect(eventStore.getSession(sessionId)?.selectedModel).toBe('claude-sonnet-4-6');
    expect(transport._sent).toContainEqual(
      expect.objectContaining({
        type: 'error',
        error: expect.stringContaining('Start a new task'),
      }),
    );
    expect(transport._sent.some((message) => message.type === 'user_message')).toBe(false);
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
    expect(result).toMatchObject({ kind: 'accepted' });

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
    session.sessionId = `sess-int-${Date.now()}`;
    session.inputQueue = { push: pushSpy, close: vi.fn() };
    session.queryInstance = {
      interrupt: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      stopTask: vi.fn().mockResolvedValue(undefined),
    };

    const clientMsgId = `user-${Date.now()}-def`;
    const result = await interruptChat(CLIENT_ID, 'Urgent', undefined, undefined, clientMsgId);
    expect(result).toMatchObject({ kind: 'accepted' });

    const userMsgEvents = transport._sent.filter(
      (m: Record<string, unknown>) => m.type === 'user_message',
    );
    expect(userMsgEvents).toHaveLength(1);
    expect((userMsgEvents[0] as Record<string, unknown>).messageId).toBe(clientMsgId);
  });

  it('deduplicates echo but still interrupts on retried clientMsgId', async () => {
    const transport = mockTransport();
    const pushSpy = vi.fn();
    const interruptSpy = vi.fn().mockResolvedValue(undefined);

    registry.register(CLIENT_ID, {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
    });

    const session = registry.get(CLIENT_ID)!;
    session.sessionId = `sess-int-dedup-${Date.now()}`;
    session.inputQueue = { push: pushSpy, close: vi.fn() };
    session.queryInstance = {
      interrupt: interruptSpy,
      close: vi.fn(),
      stopTask: vi.fn().mockResolvedValue(undefined),
    };

    const clientMsgId = `user-int-dedup-${Date.now()}`;
    expect(
      await interruptChat(CLIENT_ID, 'First', undefined, undefined, clientMsgId),
    ).toMatchObject({
      kind: 'accepted',
    });
    expect(interruptSpy).toHaveBeenCalledTimes(1);

    // Exact accepted retry is a receipt replay: it must not re-interrupt.
    const result = await interruptChat(CLIENT_ID, 'First', undefined, undefined, clientMsgId);
    expect(result).toMatchObject({ kind: 'duplicate_already_accepted' });
    expect(interruptSpy).toHaveBeenCalledTimes(1);
    // transport should only have ONE user_message echo (deduped)
    const userMsgs = transport._sent.filter(
      (m: Record<string, unknown>) => m.type === 'user_message',
    );
    expect(userMsgs).toHaveLength(1);
    // inputQueue should only get ONE push (no double-queue on retry)
    expect(pushSpy).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent exact retries before provider admission', async () => {
    const transport = mockTransport();
    const pushSpy = vi.fn();
    let releaseInterrupt!: () => void;
    const interruptSpy = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseInterrupt = resolve;
        }),
    );
    const messageId = `user-int-concurrent-${Date.now()}`;
    registry.register(CLIENT_ID, {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
    });
    const session = registry.get(CLIENT_ID)!;
    session.sessionId = `sess-int-concurrent-${Date.now()}`;
    session.inputQueue = { push: pushSpy, close: vi.fn() };
    session.queryInstance = { interrupt: interruptSpy, close: vi.fn(), stopTask: vi.fn() };

    const first = interruptChat(CLIENT_ID, 'Only once', undefined, undefined, messageId);
    const second = interruptChat(CLIENT_ID, 'Only once', undefined, undefined, messageId);
    await Promise.resolve();
    expect(interruptSpy).toHaveBeenCalledTimes(1);
    releaseInterrupt();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: 'accepted' },
      { kind: 'accepted' },
    ]);
    expect(pushSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects a mismatched payload under an accepted interrupt ID without redelivery', async () => {
    const transport = mockTransport();
    const pushSpy = vi.fn();
    const interruptSpy = vi.fn().mockResolvedValue(undefined);
    const messageId = `user-int-conflict-${Date.now()}`;
    registry.register(CLIENT_ID, {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
    });
    const session = registry.get(CLIENT_ID)!;
    session.sessionId = `sess-int-conflict-${Date.now()}`;
    session.inputQueue = { push: pushSpy, close: vi.fn() };
    session.queryInstance = { interrupt: interruptSpy, close: vi.fn(), stopTask: vi.fn() };

    await expect(
      interruptChat(CLIENT_ID, 'First', undefined, undefined, messageId),
    ).resolves.toMatchObject({
      kind: 'accepted',
    });
    await expect(
      interruptChat(CLIENT_ID, 'Different', undefined, undefined, messageId),
    ).resolves.toMatchObject({
      kind: 'conflict',
    });
    expect(interruptSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).toHaveBeenCalledTimes(1);
  });

  it('commits accepted interrupt history even if the live echo transport throws', async () => {
    const transport = mockTransport();
    vi.mocked(transport.send).mockImplementation(() => {
      throw new Error('socket write failed');
    });
    const pushSpy = vi.fn();
    const sessionId = `sess-int-throwing-transport-${Date.now()}`;
    const messageId = `user-int-throwing-transport-${Date.now()}`;
    registry.register(CLIENT_ID, {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
    });
    const session = registry.get(CLIENT_ID)!;
    session.sessionId = sessionId;
    session.inputQueue = { push: pushSpy, close: vi.fn() };
    session.queryInstance = {
      interrupt: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      stopTask: vi.fn(),
    };
    eventStore.upsertSession({ sessionId });

    await expect(
      interruptChat(CLIENT_ID, 'Persist despite socket', undefined, undefined, messageId),
    ).resolves.toMatchObject({
      kind: 'accepted',
    });
    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(
      eventStore.getSessionEvents(sessionId).filter((event) => event.type === 'user_message'),
    ).toHaveLength(1);
  });

  it('leaves a rejected interrupt retryable, then stores and echoes it exactly once', async () => {
    const transport = mockTransport();
    const pushSpy = vi.fn();
    const interruptSpy = vi
      .fn()
      .mockRejectedValueOnce(new Error('provider rejected before accepting input'))
      .mockResolvedValueOnce(undefined);
    const sessionId = `sess-int-retry-${Date.now()}`;
    const clientMsgId = `user-int-retry-${Date.now()}`;

    registry.register(CLIENT_ID, {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
    });
    const session = registry.get(CLIENT_ID)!;
    session.sessionId = sessionId;
    session.inputQueue = { push: pushSpy, close: vi.fn() };
    session.queryInstance = {
      interrupt: interruptSpy,
      close: vi.fn(),
      stopTask: vi.fn().mockResolvedValue(undefined),
    };
    eventStore.upsertSession({ sessionId });

    await expect(
      interruptChat(CLIENT_ID, 'Retry this', undefined, undefined, clientMsgId),
    ).resolves.toMatchObject({ kind: 'unavailable_unreported' });
    expect(pushSpy).not.toHaveBeenCalled();
    expect(transport._sent.some((message) => message.type === 'user_message')).toBe(false);
    expect(
      eventStore.getSessionEvents(sessionId).some((event) => event.type === 'user_message'),
    ).toBe(false);

    await expect(
      interruptChat(CLIENT_ID, 'Retry this', undefined, undefined, clientMsgId),
    ).resolves.toMatchObject({ kind: 'accepted' });
    expect(interruptSpy).toHaveBeenCalledTimes(2);
    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(transport._sent.filter((message) => message.type === 'user_message')).toHaveLength(1);
    expect(
      eventStore.getSessionEvents(sessionId).filter((event) => event.type === 'user_message'),
    ).toHaveLength(1);
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

  it('rejects an active Anthropic model switch before interrupting or persisting it', async () => {
    const transport = mockTransport();
    const pushSpy = vi.fn();
    const interruptSpy = vi.fn().mockResolvedValue(undefined);
    const sessionId = `sess-anthropic-interrupt-model-${Date.now()}`;
    registry.register(CLIENT_ID, {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
    });

    const session = registry.get(CLIENT_ID)!;
    session.sessionId = sessionId;
    session.model = 'claude-sonnet-4-6';
    session.inputQueue = { push: pushSpy, close: vi.fn() };
    session.queryInstance = {
      interrupt: interruptSpy,
      close: vi.fn(),
      stopTask: vi.fn().mockResolvedValue(undefined),
    };
    eventStore.upsertSession({ sessionId, selectedModel: session.model });

    expect(
      await interruptChat(
        CLIENT_ID,
        'Interrupt with the other model',
        undefined,
        undefined,
        'user-anthropic-interrupt-model',
        'claude-opus-4-6',
      ),
    ).toMatchObject({ kind: 'rejected_already_reported' });
    expect(interruptSpy).not.toHaveBeenCalled();
    expect(pushSpy).not.toHaveBeenCalled();
    expect(eventStore.getSession(sessionId)?.selectedModel).toBe('claude-sonnet-4-6');
    expect(transport._sent.some((message) => message.type === 'user_message')).toBe(false);
  });
});
