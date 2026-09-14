import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ManagedSession } from '@mitzo/harness';
const runtime = vi.hoisted(() => ({
  enqueue: vi.fn(),
  send: vi.fn().mockResolvedValue(undefined),
  resumeAfterExplicitSend: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../codex-chat-session.js', () => ({
  getCodexRuntime: () => runtime,
  openCodexChat: vi.fn(),
}));
const root = mkdtempSync(join(tmpdir(), 'codex-queue-retry-'));
vi.stubEnv('REPO_PATH', root);
const chat = await import('../chat.js');
beforeEach(() => {
  runtime.enqueue.mockReset();
  runtime.resumeAfterExplicitSend.mockReset().mockResolvedValue(undefined);
  runtime.send.mockReset().mockImplementation(async (_input, onEnqueued?: () => void) => {
    onEnqueued?.();
  });
});
afterAll(() => {
  chat.eventStore.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
it('routes an idle follow-up through the recovery-aware send before acknowledging it', async () => {
  const send = vi.fn();
  let acknowledge: (() => void) | undefined;
  runtime.send.mockImplementationOnce(async (_input, onEnqueued?: () => void) => {
    acknowledge = onEnqueued;
  });
  vi.spyOn(chat.registry, 'get').mockReturnValue({
    inputQueue: {},
    sessionId: 's',
    cwd: root,
    transport: { send, isOpen: () => true },
    observers: new Set(),
  } as unknown as ManagedSession);
  vi.spyOn(chat.eventStore, 'hasUserMessage').mockReturnValue(true);
  expect(chat.sendToChat('c', 'hello', undefined, undefined, 'same-id')).toBe(true);
  expect(runtime.send).toHaveBeenCalledWith(
    { id: 'same-id', prompt: 'hello' },
    expect.any(Function),
  );
  expect(runtime.enqueue).not.toHaveBeenCalled();
  expect(runtime.resumeAfterExplicitSend).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();

  acknowledge?.();
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
  runtime.send.mockRejectedValueOnce(new Error('disk full'));
  expect(chat.sendToChat('c', 'hello', undefined, undefined, 'new-id')).toBe(true);
  expect(echo).not.toHaveBeenCalled();
  await vi.waitFor(() =>
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })),
  );
});

it('queues image and thinking input on an existing conversation', () => {
  const images = [{ data: 'aGVsbG8=', mediaType: 'image/png' }];
  expect(chat.sendToChat('c', 'describe', images, undefined, 'image-followup', 'gpt', 'high')).toBe(
    true,
  );
  expect(runtime.send).toHaveBeenLastCalledWith(
    {
      id: 'image-followup',
      prompt: 'describe',
      model: 'gpt',
      reasoningEffort: 'high',
      images,
    },
    expect.any(Function),
  );
});
