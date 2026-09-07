import { afterAll, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ManagedSession } from '@mitzo/harness';
const runtime = vi.hoisted(() => ({
  enqueue: vi.fn(),
  send: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../codex-chat-session.js', () => ({
  getCodexRuntime: () => runtime,
  openCodexChat: vi.fn(),
}));
const root = mkdtempSync(join(tmpdir(), 'codex-queue-retry-'));
vi.stubEnv('REPO_PATH', root);
const chat = await import('../chat.js');
afterAll(() => {
  chat.eventStore.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
it('repairs a private queue after a previously echoed message without echoing it twice', () => {
  const send = vi.fn();
  vi.spyOn(chat.registry, 'get').mockReturnValue({
    inputQueue: {},
    sessionId: 's',
    cwd: root,
    transport: { send, isOpen: () => true },
    observers: new Set(),
  } as unknown as ManagedSession);
  vi.spyOn(chat.eventStore, 'hasUserMessage').mockReturnValue(true);
  expect(chat.sendToChat('c', 'hello', undefined, undefined, 'same-id')).toBe(true);
  expect(runtime.enqueue).toHaveBeenCalledWith({ id: 'same-id', prompt: 'hello' });
  expect(runtime.send).toHaveBeenCalledWith({ id: 'same-id', prompt: 'hello' });
  expect(send).not.toHaveBeenCalled();
});
it('does not acknowledge or echo a message when durable enqueue fails', () => {
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
  runtime.enqueue.mockImplementationOnce(() => {
    throw new Error('disk full');
  });
  expect(chat.sendToChat('c', 'hello', undefined, undefined, 'new-id')).toBe(false);
  expect(echo).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
});
