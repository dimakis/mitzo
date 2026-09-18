import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ManagedSession } from '@mitzo/harness';
const runtime = vi.hoisted(() => ({
  admitExplicitSend: vi.fn(),
  enqueue: vi.fn(),
  interrupt: vi.fn().mockResolvedValue(undefined),
  send: vi.fn().mockResolvedValue(undefined),
  resumeAfterExplicitSend: vi.fn().mockResolvedValue(undefined),
  cancelQueued: vi.fn().mockReturnValue('cancelled'),
}));
vi.mock('../codex-chat-session.js', () => ({
  getCodexRuntime: () => runtime,
  openCodexChat: vi.fn(),
}));
const root = mkdtempSync(join(tmpdir(), 'codex-queue-retry-'));
vi.stubEnv('REPO_PATH', root);
const chat = await import('../chat.js');
beforeEach(() => {
  runtime.admitExplicitSend.mockReset().mockResolvedValue({
    model: 'gpt',
    reasoningEffort: undefined,
  });
  runtime.enqueue.mockReset();
  runtime.interrupt.mockReset().mockResolvedValue(undefined);
  runtime.resumeAfterExplicitSend.mockReset().mockResolvedValue(undefined);
  runtime.cancelQueued.mockReset().mockReturnValue('cancelled');
  runtime.send.mockReset().mockImplementation(async (_input, onEnqueued?: () => void) => {
    onEnqueued?.();
  });
});
afterAll(() => {
  chat.eventStore.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
it('waits for recovery-aware admission before acknowledging an idle follow-up', async () => {
  const send = vi.fn();
  let admit!: (selection: { model: string; reasoningEffort?: string | null }) => void;
  runtime.admitExplicitSend.mockImplementationOnce(() => {
    return new Promise((resolve) => {
      admit = resolve;
    });
  });
  vi.spyOn(chat.registry, 'get').mockReturnValue({
    inputQueue: {},
    sessionId: 's',
    cwd: root,
    transport: { send, isOpen: () => true },
    observers: new Set(),
  } as unknown as ManagedSession);
  vi.spyOn(chat.eventStore, 'hasUserMessage').mockReturnValue(true);
  const result = chat.sendToChat('c', 'hello', undefined, undefined, 'same-id');
  expect(runtime.admitExplicitSend).toHaveBeenCalledWith(
    {
      id: 'same-id',
      prompt: 'hello',
      intent: 'hello',
      images: undefined,
      reasoningEffort: undefined,
    },
    undefined,
  );
  expect(runtime.enqueue).not.toHaveBeenCalled();
  expect(runtime.resumeAfterExplicitSend).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();

  admit({ model: 'gpt', reasoningEffort: undefined });
  await expect(result).resolves.toBe(true);
  expect(runtime.resumeAfterExplicitSend).toHaveBeenCalledOnce();
  expect(send).not.toHaveBeenCalled();
});
it('does not acknowledge or echo a message when durable enqueue fails', async () => {
  const send = vi.fn();
  vi.spyOn(chat.registry, 'get').mockReturnValue({
    inputQueue: {},
    sessionId: 's',
    cwd: root,
    transport: { send, isOpen: () => true },
    observers: new Set(),
  } as unknown as ManagedSession);
  const echo = vi.spyOn(chat.eventStore, 'hasUserMessage').mockReturnValue(false);
  echo.mockClear();
  runtime.admitExplicitSend.mockRejectedValueOnce(new Error('disk full'));
  await expect(chat.sendToChat('c', 'hello', undefined, undefined, 'new-id')).resolves.toBe(false);
  expect(echo).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
});

it('queues image and thinking input on an existing conversation', async () => {
  const images = [{ data: 'aGVsbG8=', mediaType: 'image/png' }];
  runtime.admitExplicitSend.mockResolvedValueOnce({ model: 'gpt', reasoningEffort: 'high' });
  await expect(
    chat.sendToChat('c', 'describe', images, undefined, 'image-followup', 'gpt', 'high'),
  ).resolves.toBe(true);
  expect(runtime.admitExplicitSend).toHaveBeenLastCalledWith(
    {
      id: 'image-followup',
      prompt: 'describe',
      intent: 'describe',
      model: 'gpt',
      reasoningEffort: 'high',
      images,
    },
    undefined,
  );
});

it('terminalizes a replacement when Codex resume rejects, without retrying the provider', async () => {
  // Earlier queue tests intentionally use temporary registry spies. This
  // replacement exercise needs the real immutable lease/controller path.
  vi.restoreAllMocks();
  const clientId = `codex-replacement-${Date.now()}`;
  const sessionId = `codex-replacement-session-${Date.now()}`;
  const transport = { send: vi.fn(), isOpen: () => true };
  chat.registry.register(clientId, {
    transport,
    abortController: new AbortController(),
    mode: 'agent',
    sessionId,
    cwd: root,
    sessionAllowList: new Set(),
  });
  try {
    const session = chat.registry.get(clientId)!;
    session.inputQueue = {
      push: vi.fn(),
      close: vi.fn(),
    } as unknown as ManagedSession['inputQueue'];
    session.queryInstance = { interrupt: vi.fn(), close: vi.fn(), stopTask: vi.fn() };
    chat.eventStore.upsertSession({ sessionId });
    session.currentExecution = chat.eventStore.beginExecution(sessionId, 'codex-old-turn').token;
    runtime.resumeAfterExplicitSend.mockRejectedValueOnce(new Error('resume denied'));
    runtime.cancelQueued.mockImplementationOnce((commandId: string) => {
      // Cancellation happens inside the dispatch failure path while the
      // durable replacement is still RUNNING; ExecutionController only writes
      // its failed terminal transition after this non-claimable tombstone.
      expect(commandId).toBe('codex-replacement-message');
      expect(chat.eventStore.getSession(sessionId)).toMatchObject({
        executionPhase: 'RUNNING',
        executionGeneration: 2,
      });
      return 'cancelled';
    });

    const outcome = await chat.interruptChat(
      clientId,
      'replacement',
      undefined,
      undefined,
      'codex-replacement-message',
    );
    expect(outcome).toEqual({ kind: 'accepted' });

    const stored = chat.eventStore.getSession(sessionId)!;
    expect(stored).toMatchObject({
      executionPhase: 'TERMINAL',
      executionGeneration: 2,
      executionTerminalReason: 'failed',
    });
    expect(chat.registry.get(clientId)?.currentExecution).toBeUndefined();
    expect(runtime.resumeAfterExplicitSend).toHaveBeenCalledTimes(1);
    expect(runtime.cancelQueued).toHaveBeenCalledWith('codex-replacement-message');

    await expect(
      chat.interruptChat(
        clientId,
        'replacement',
        undefined,
        undefined,
        'codex-replacement-message',
      ),
    ).resolves.toEqual({ kind: 'duplicate_already_accepted' });
    expect(runtime.interrupt).toHaveBeenCalledTimes(1);
    expect(runtime.resumeAfterExplicitSend).toHaveBeenCalledTimes(1);
    expect(runtime.cancelQueued).toHaveBeenCalledTimes(1);
  } finally {
    chat.registry.abort(clientId);
  }
});
