import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eventStore, registry, sendToChat, interruptChat, stageImages, stopChat } from '../chat.js';
import { ExecutionController } from '../execution-controller.js';
import { MAX_V2_PROMPT_CHARS } from '@mitzo/protocol';
import type { SessionTransport } from '@mitzo/harness';
import { QUERY_FIRST_EVENT_TIMEOUT_MS } from '../constants.js';

function mockTransport(open = true): SessionTransport & { _sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  return {
    send: vi.fn((data: Record<string, unknown>) => sent.push(data)),
    isOpen: () => open,
    _sent: sent,
  };
}

function activateInterruptExecution(clientId: string): void {
  const session = registry.get(clientId)!;
  eventStore.upsertSession({ sessionId: session.sessionId! });
  const existing = eventStore.getSession(session.sessionId!);
  if (existing?.executionPhase && existing.executionPhase !== 'TERMINAL' && existing.executionId) {
    eventStore.transitionExecution(
      {
        sessionId: session.sessionId!,
        executionId: existing.executionId,
        generation: existing.executionGeneration,
      },
      'TERMINAL',
      'completed',
    );
  }
  session.currentExecution = eventStore.beginExecution(
    session.sessionId!,
    `interrupt-active-${session.sessionId}`,
  ).token;
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
  const tempDirs: string[] = [];

  afterEach(() => {
    registry.abort(CLIENT_ID);
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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

    activateInterruptExecution(CLIENT_ID);
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
    activateInterruptExecution(CLIENT_ID);
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
    activateInterruptExecution(CLIENT_ID);
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

  it('admits ordinary active follow-ups FIFO and coalesces queued exact retries', async () => {
    const transport = mockTransport();
    const pushSpy = vi.fn();
    const sessionId = `sess-send-fifo-${Date.now()}`;
    registry.register(CLIENT_ID, {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionId,
      sessionAllowList: new Set(),
    });
    const session = registry.get(CLIENT_ID)!;
    session.inputQueue = { push: pushSpy, close: vi.fn() };
    eventStore.upsertSession({ sessionId });
    const initial = eventStore.beginExecution(
      sessionId,
      'active-initial',
      'initial-send',
      'fp-initial',
    );
    session.currentExecution = initial.token;

    const first = sendToChat(CLIENT_ID, 'first FIFO follow-up', undefined, undefined, 'fifo-one');
    const exactRetry = sendToChat(
      CLIENT_ID,
      'first FIFO follow-up',
      undefined,
      undefined,
      'fifo-one',
    );
    const conflict = sendToChat(CLIENT_ID, 'different payload', undefined, undefined, 'fifo-one');
    const second = sendToChat(CLIENT_ID, 'second FIFO follow-up', undefined, undefined, 'fifo-two');
    await expect(conflict).resolves.toBe(false);
    expect(registry.get(CLIENT_ID)?.pendingExecutions).toHaveLength(2);
    expect(pushSpy).not.toHaveBeenCalled();

    const controller = new ExecutionController({ registry, eventStore });
    await controller.finishExecution(
      registry.getRuntimeLease(CLIENT_ID)!,
      initial.token,
      'completed',
    );
    await expect(Promise.all([first, exactRetry])).resolves.toEqual([true, true]);
    expect(registry.get(CLIENT_ID)?.currentExecution).toMatchObject({ generation: 2 });
    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy.mock.calls[0][0]).toMatchObject({
      executionToken: expect.objectContaining({ generation: 2 }),
    });

    const firstToken = registry.get(CLIENT_ID)!.currentExecution!;
    await controller.finishExecution(registry.getRuntimeLease(CLIENT_ID)!, firstToken, 'completed');
    await expect(second).resolves.toBe(true);
    expect(registry.get(CLIENT_ID)?.currentExecution).toMatchObject({ generation: 3 });
    expect(pushSpy).toHaveBeenCalledTimes(2);
    expect(pushSpy.mock.calls[1][0]).toMatchObject({
      executionToken: expect.objectContaining({ generation: 3 }),
    });
    expect(
      eventStore.getSessionEvents(sessionId).filter((event) => event.type === 'user_message'),
    ).toHaveLength(2);
  });

  it('drains queued follow-up receipts on stop without dispatching them', async () => {
    const transport = mockTransport();
    const pushSpy = vi.fn();
    const sessionId = `sess-send-stop-${Date.now()}`;
    const queuedClientMsgId = `queued-stop-${Date.now()}-${Math.random()}`;
    registry.register(CLIENT_ID, {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionId,
      sessionAllowList: new Set(),
    });
    const session = registry.get(CLIENT_ID)!;
    session.inputQueue = { push: pushSpy, close: vi.fn() };
    session.queryInstance = { close: vi.fn(), interrupt: vi.fn(), stopTask: vi.fn() };
    eventStore.upsertSession({ sessionId });
    session.currentExecution = eventStore.beginExecution(
      sessionId,
      'active-stop',
      'initial-stop',
      'fp-stop',
    ).token;

    // The HTTP receipt is durable before the bounded FIFO entry exists.
    eventStore.insertSendCommand(queuedClientMsgId, sessionId, {}, 'queued-stop-fingerprint');
    const queued = sendToChat(
      CLIENT_ID,
      'must not dispatch',
      undefined,
      undefined,
      queuedClientMsgId,
    );
    expect(registry.get(CLIENT_ID)?.pendingExecutions).toHaveLength(1);
    await stopChat(CLIENT_ID);
    await expect(queued).resolves.toBe(false);
    expect(pushSpy).not.toHaveBeenCalled();
    expect(eventStore.getSession(sessionId)).toMatchObject({
      executionPhase: 'TERMINAL',
      executionTerminalReason: 'stopped',
    });
    const failures = eventStore
      .getSessionEvents(sessionId)
      .filter((event) => event.type === 'queued_send_failed');
    expect(failures).toHaveLength(1);
    expect(failures[0].payload).toMatchObject({
      sessionId,
      clientMsgId: queuedClientMsgId,
      error: 'Queued message could not be started. Please retry.',
    });
    expect(transport._sent).toContainEqual(
      expect.objectContaining({
        type: 'queued_send_failed',
        clientMsgId: queuedClientMsgId,
        sessionId,
        seq: failures[0].seq,
      }),
    );
  });

  it('replays an Anthropic receipt before a later active-model policy check', async () => {
    const transport = mockTransport();
    const pushSpy = vi.fn();
    const interruptSpy = vi.fn().mockResolvedValue(undefined);
    const clientMsgId = `anthropic-policy-retry-${Date.now()}`;

    registry.register(CLIENT_ID, {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      model: 'admitted-model',
      sessionAllowList: new Set(),
    });
    const session = registry.get(CLIENT_ID)!;
    session.sessionId = `sess-anthropic-policy-${Date.now()}`;
    session.inputQueue = { push: pushSpy, close: vi.fn() };
    session.queryInstance = {
      interrupt: interruptSpy,
      close: vi.fn(),
      stopTask: vi.fn().mockResolvedValue(undefined),
    };
    activateInterruptExecution(CLIENT_ID);

    await expect(
      interruptChat(
        CLIENT_ID,
        'same immutable wire request',
        undefined,
        undefined,
        clientMsgId,
        'admitted-model',
      ),
    ).resolves.toEqual({ kind: 'accepted' });

    // The active profile changes after durable admission. An exact retry must
    // replay the receipt without inspecting the mutable Anthropic policy.
    session.model = 'later-active-model';
    await expect(
      interruptChat(
        CLIENT_ID,
        'same immutable wire request',
        undefined,
        undefined,
        clientMsgId,
        'admitted-model',
      ),
    ).resolves.toEqual({ kind: 'duplicate_already_accepted' });
    expect(interruptSpy).toHaveBeenCalledOnce();
    expect(pushSpy).toHaveBeenCalledOnce();

    await expect(
      interruptChat(
        CLIENT_ID,
        'changed wire request',
        undefined,
        undefined,
        clientMsgId,
        'admitted-model',
      ),
    ).resolves.toEqual({ kind: 'conflict' });
    await expect(
      interruptChat(
        CLIENT_ID,
        'new request still uses the current policy',
        undefined,
        undefined,
        `${clientMsgId}-new`,
        'admitted-model',
      ),
    ).resolves.toEqual({ kind: 'rejected_already_reported' });
    expect(interruptSpy).toHaveBeenCalledOnce();
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

    activateInterruptExecution(CLIENT_ID);
    const first = interruptChat(CLIENT_ID, 'Only once', undefined, undefined, messageId);
    const second = interruptChat(CLIENT_ID, 'Only once', undefined, undefined, messageId);
    await vi.waitFor(() => expect(interruptSpy).toHaveBeenCalledTimes(1));
    releaseInterrupt();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: 'accepted' },
      { kind: 'duplicate_already_accepted' },
    ]);
    expect(pushSpy).toHaveBeenCalledTimes(1);
  });

  it('commits replacement ownership before provider delivery and never redoes it for a retry', async () => {
    const oldTransport = mockTransport();
    const requesterTransport = mockTransport();
    const pushSpy = vi.fn();
    const interruptSpy = vi.fn(() => {
      const current = registry.get(CLIENT_ID)!;
      expect(current.transport).toBe(requesterTransport);
      expect(current.ownerConnectionId).toBe('requester');
    });
    const messageId = `user-int-owner-${Date.now()}`;

    registry.register(CLIENT_ID, {
      transport: oldTransport,
      ownerConnectionId: 'old-owner',
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
    });
    const session = registry.get(CLIENT_ID)!;
    session.sessionId = `sess-int-owner-${Date.now()}`;
    session.inputQueue = { push: pushSpy, close: vi.fn() };
    session.queryInstance = { interrupt: interruptSpy, close: vi.fn(), stopTask: vi.fn() };
    activateInterruptExecution(CLIENT_ID);

    const lease = registry.getRuntimeLease(CLIENT_ID)!;
    const expected = registry.getRuntimeOwnerSnapshot(lease)!;
    const committed = vi.fn();
    await expect(
      interruptChat(CLIENT_ID, 'Take over', undefined, undefined, messageId, undefined, undefined, {
        expected,
        requesterConnectionId: 'requester',
        requesterTransport,
        onCommitted: committed,
      }),
    ).resolves.toEqual({ kind: 'accepted' });

    expect(committed).toHaveBeenCalledOnce();
    expect(interruptSpy).toHaveBeenCalledOnce();
    expect(pushSpy).toHaveBeenCalledOnce();
    expect(oldTransport._sent).toEqual([]);
    expect(requesterTransport._sent.some((row) => row.type === 'user_message')).toBe(true);

    await expect(
      interruptChat(CLIENT_ID, 'Take over', undefined, undefined, messageId, undefined, undefined, {
        // A completed receipt must short-circuit before a stale owner snapshot
        // could cause another ownership mutation or provider delivery.
        expected,
        requesterConnectionId: 'different-requester',
        requesterTransport: oldTransport,
        onCommitted: committed,
      }),
    ).resolves.toEqual({ kind: 'duplicate_already_accepted' });
    expect(committed).toHaveBeenCalledOnce();
    expect(interruptSpy).toHaveBeenCalledOnce();
    expect(pushSpy).toHaveBeenCalledOnce();
  });

  it('rejects a stale owner snapshot before replacement admission or provider delivery', async () => {
    const oldTransport = mockTransport();
    const newerOwnerTransport = mockTransport();
    const requesterTransport = mockTransport();
    const interruptSpy = vi.fn();
    const pushSpy = vi.fn();

    registry.register(CLIENT_ID, {
      transport: oldTransport,
      ownerConnectionId: 'old-owner',
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
    });
    const session = registry.get(CLIENT_ID)!;
    session.sessionId = `sess-int-stale-owner-${Date.now()}`;
    session.inputQueue = { push: pushSpy, close: vi.fn() };
    session.queryInstance = { interrupt: interruptSpy, close: vi.fn(), stopTask: vi.fn() };
    activateInterruptExecution(CLIENT_ID);

    const lease = registry.getRuntimeLease(CLIENT_ID)!;
    const staleOwner = registry.getRuntimeOwnerSnapshot(lease)!;
    expect(registry.promoteRuntimeOwner(CLIENT_ID, 'newer-owner', newerOwnerTransport)).toBe(true);

    await expect(
      interruptChat(
        CLIENT_ID,
        'Must not deliver',
        undefined,
        undefined,
        `user-int-stale-owner-${Date.now()}`,
        undefined,
        undefined,
        {
          expected: staleOwner,
          requesterConnectionId: 'requester',
          requesterTransport,
        },
      ),
    ).resolves.toEqual({ kind: 'unavailable_unreported' });

    expect(interruptSpy).not.toHaveBeenCalled();
    expect(pushSpy).not.toHaveBeenCalled();
    expect(oldTransport._sent).toEqual([]);
    expect(newerOwnerTransport._sent).toEqual([]);
    expect(requesterTransport._sent).toEqual([]);
    expect(registry.get(CLIENT_ID)?.transport).toBe(newerOwnerTransport);
    // Owner fencing runs before EventStore admission: the old generation
    // remains truthful and no phantom replacement/user-message is replayable.
    expect(eventStore.getSession(session.sessionId)?.executionPhase).toBe('RUNNING');
    expect(
      eventStore
        .getSessionEvents(session.sessionId!)
        .filter((event) => event.type === 'user_message'),
    ).toHaveLength(0);
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

    activateInterruptExecution(CLIENT_ID);
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

    activateInterruptExecution(CLIENT_ID);
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

    activateInterruptExecution(CLIENT_ID);
    await expect(
      interruptChat(CLIENT_ID, 'Retry this', undefined, undefined, clientMsgId),
    ).resolves.toMatchObject({ kind: 'accepted' });

    await expect(
      interruptChat(CLIENT_ID, 'Retry this', undefined, undefined, clientMsgId),
    ).resolves.toMatchObject({ kind: 'duplicate_already_accepted' });
    expect(interruptSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).not.toHaveBeenCalled();
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

    activateInterruptExecution(CLIENT_ID);
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

    activateInterruptExecution(CLIENT_ID);
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

  it('stages validated interrupt images into the Anthropic provider prompt once', async () => {
    const transport = mockTransport();
    const push = vi.fn();
    const sessionId = `sess-anthropic-image-${Date.now()}`;
    const cwd = mkdtempSync(join(tmpdir(), 'mitzo-anthropic-image-'));
    tempDirs.push(cwd);
    registry.register(CLIENT_ID, {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
    });
    const session = registry.get(CLIENT_ID)!;
    session.sessionId = sessionId;
    session.cwd = cwd;
    session.inputQueue = { push, close: vi.fn() };
    session.queryInstance = { interrupt: vi.fn(), close: vi.fn(), stopTask: vi.fn() };
    eventStore.upsertSession({ sessionId });
    activateInterruptExecution(CLIENT_ID);
    const images = [
      { data: Buffer.from('provider-visible-image').toString('base64'), mediaType: 'image/png' },
    ];

    await expect(
      interruptChat(CLIENT_ID, 'inspect image', images, undefined, 'anthropic-image-interrupt'),
    ).resolves.toEqual({ kind: 'accepted' });
    const providerContent = (
      push.mock.calls[0][0] as {
        message: { message: { content: string } };
      }
    ).message.message.content;
    const stagedPath = providerContent.match(/- (.+\.png)$/m)?.[1];
    expect(stagedPath).toMatch(
      new RegExp(`^${cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.mitzo-images/`),
    );
    expect(readFileSync(stagedPath!)).toEqual(Buffer.from('provider-visible-image'));

    await expect(
      interruptChat(CLIENT_ID, 'inspect image', images, undefined, 'anthropic-image-interrupt'),
    ).resolves.toEqual({ kind: 'duplicate_already_accepted' });
    expect(push).toHaveBeenCalledOnce();
    expect(readdirSync(join(cwd, '.mitzo-images'))).toHaveLength(1);
  });

  it('removes staged interrupt files when durable replacement admission fails', async () => {
    const transport = mockTransport();
    const cwd = mkdtempSync(join(tmpdir(), 'mitzo-anthropic-image-failure-'));
    tempDirs.push(cwd);
    const sessionId = `sess-anthropic-image-failure-${Date.now()}`;
    registry.register(CLIENT_ID, {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
    });
    const session = registry.get(CLIENT_ID)!;
    session.sessionId = sessionId;
    session.cwd = cwd;
    session.inputQueue = { push: vi.fn(), close: vi.fn() };
    session.queryInstance = { interrupt: vi.fn(), close: vi.fn(), stopTask: vi.fn() };
    eventStore.upsertSession({ sessionId });
    activateInterruptExecution(CLIENT_ID);
    const admission = vi.spyOn(eventStore, 'admitReplacement').mockImplementationOnce(() => {
      throw new Error('injected admission failure');
    });

    await expect(
      interruptChat(
        CLIENT_ID,
        'will not persist',
        [{ data: 'c3RhZ2VkLWJ1dC1yZW1vdmVk', mediaType: 'image/png' }],
        undefined,
        'anthropic-image-failure',
      ),
    ).resolves.toEqual({ kind: 'unavailable_unreported' });
    admission.mockRestore();
    const imageDirectory = join(cwd, '.mitzo-images');
    expect(existsSync(imageDirectory) ? readdirSync(imageDirectory) : []).toEqual([]);
  });

  it('bounds stalled Anthropic replacement envelopes before durable admission', async () => {
    const transport = mockTransport();
    const pushSpy = vi.fn();
    const interruptSpy = vi.fn().mockResolvedValue(undefined);
    const sessionId = `sess-int-barrier-${Date.now()}`;
    registry.register(CLIENT_ID, {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
    });
    const session = registry.get(CLIENT_ID)!;
    session.sessionId = sessionId;
    session.inputQueue = { push: pushSpy, close: vi.fn() };
    session.queryInstance = { interrupt: interruptSpy, close: vi.fn(), stopTask: vi.fn() };
    eventStore.upsertSession({ sessionId });
    activateInterruptExecution(CLIENT_ID);

    // The wire prompt ceiling is smaller than the retained-envelope ceiling;
    // use it to exercise the largest legitimate command without bypassing
    // request validation through this direct handler harness.
    const nearMaxPrompt = 'x'.repeat(MAX_V2_PROMPT_CHARS - 1);
    await expect(
      interruptChat(CLIENT_ID, nearMaxPrompt, undefined, undefined, 'barrier-first'),
    ).resolves.toEqual({ kind: 'accepted' });
    expect(session.replacementInputBarrier?.retainedBytes).toBe(nearMaxPrompt.length);

    for (let index = 0; index < 8; index++) {
      await expect(
        interruptChat(CLIENT_ID, `different ${index}`, undefined, undefined, `barrier-${index}`),
      ).resolves.toEqual({ kind: 'unavailable_unreported' });
    }
    // One durable replacement/user message and one provider delivery: the
    // stalled SDK cannot grow EventStore rows or retained input unboundedly.
    expect(interruptSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(
      eventStore.getSessionEvents(sessionId).filter((event) => event.type === 'user_message'),
    ).toHaveLength(1);
    expect(session.replacementInputBarrier?.retainedBytes).toBe(nearMaxPrompt.length);
  });

  it('times out a stalled Anthropic replacement once and tears down only its token', async () => {
    vi.useFakeTimers();
    try {
      const transport = mockTransport();
      const close = vi.fn();
      const sessionId = `sess-int-barrier-timeout-${Date.now()}`;
      registry.register(CLIENT_ID, {
        transport,
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
      });
      const session = registry.get(CLIENT_ID)!;
      session.sessionId = sessionId;
      session.inputQueue = { push: vi.fn(), close: vi.fn() };
      session.queryInstance = {
        interrupt: vi.fn().mockResolvedValue(undefined),
        close,
        stopTask: vi.fn().mockResolvedValue(undefined),
      };
      eventStore.upsertSession({ sessionId });
      activateInterruptExecution(CLIENT_ID);

      await expect(
        interruptChat(CLIENT_ID, 'stuck prompt', undefined, undefined, 'barrier-timeout'),
      ).resolves.toEqual({ kind: 'accepted' });
      const replacement = session.currentExecution!;
      expect(session.replacementInputBarrier?.token).toEqual(replacement);

      await vi.advanceTimersByTimeAsync(QUERY_FIRST_EVENT_TIMEOUT_MS);
      expect(close).toHaveBeenCalledOnce();
      expect(session.currentExecution).toBeUndefined();
      expect(session.replacementInputBarrier).toBeUndefined();
      expect(eventStore.getSession(sessionId)).toMatchObject({
        executionPhase: 'TERMINAL',
        executionTerminalReason: 'failed',
      });
      expect(
        eventStore
          .getSessionEvents(sessionId)
          .filter(
            (event) =>
              event.type === 'execution_state_changed' &&
              event.payload.executionId === replacement.executionId &&
              event.payload.phase === 'TERMINAL',
          ),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses exclusive image paths and rolls back every path it created on a partial staging failure', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mitzo-image-stage-'));
    const images = [
      { data: Buffer.from('one').toString('base64'), mediaType: 'image/png' },
      { data: Buffer.from('two').toString('base64'), mediaType: 'image/png' },
    ];
    try {
      const first = stageImages(cwd, images);
      const second = stageImages(cwd, images);
      expect(new Set([...first, ...second]).size).toBe(4);
      expect(first.every((path) => existsSync(path))).toBe(true);
      expect(second.every((path) => existsSync(path))).toBe(true);

      let writes = 0;
      expect(() =>
        stageImages(cwd, images, (fd, data) => {
          writes += 1;
          if (writes === 2) throw new Error('injected second write failure');
          // The writer is deliberately passed a descriptor opened with wx;
          // this mirrors the real write without permitting path overwrite.
          writeFileSync(fd, data);
        }),
      ).toThrow('injected second write failure');
      expect(readdirSync(join(cwd, '.mitzo-images')).sort()).toEqual(
        [...first, ...second].map((path) => path.split('/').at(-1)!).sort(),
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
