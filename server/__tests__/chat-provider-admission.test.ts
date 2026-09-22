import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const responses = vi.hoisted(() => ({
  prepare: vi.fn(),
}));

vi.mock('../responses-chat-session.js', () => ({
  getResponsesRuntime: () => responses,
  openResponsesChat: vi.fn(),
}));

describe('active native provider admission', () => {
  const clientId = 'provider-admission-client';
  let root: string;
  let chat: typeof import('../chat.js');

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'mitzo-provider-admission-'));
    vi.stubEnv('REPO_PATH', root);
    vi.stubEnv('WORKTREE_ENABLED', 'false');
    chat = await import('../chat.js');
  });

  beforeEach(() => {
    responses.prepare.mockReset();
    chat.registry.abort(clientId);
  });

  afterAll(() => {
    chat.registry.abort(clientId);
    chat.eventStore.close();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('reuses the durable admission without a second provider preparation or queue push', async () => {
    const push = vi.fn();
    const sessionId = 'session-1';
    chat.registry.register(clientId, {
      transport: { send: vi.fn(), isOpen: () => true },
      abortController: new AbortController(),
      mode: 'agent',
      sessionId,
      cwd: root,
      sessionAllowList: new Set(),
    });
    chat.registry.get(clientId)!.inputQueue = { push, close: vi.fn() };
    chat.eventStore.upsertSession({ sessionId });

    await expect(
      chat.sendToChat(clientId, 'answer this', undefined, undefined, 'command-1'),
    ).resolves.toBe(true);
    await expect(
      chat.sendToChat(clientId, 'answer this', undefined, undefined, 'command-1'),
    ).resolves.toBe(true);

    expect(responses.prepare).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledOnce();
    const queued = push.mock.calls[0][0] as Record<string, unknown>;
    expect(queued.providerAdmission).toMatchObject({
      duplicate: false,
      requestFingerprint: expect.any(String),
      token: { sessionId },
    });
  });

  it('rejects a changed request before a second provider preparation', async () => {
    const push = vi.fn();
    const sessionId = 'session-2';
    chat.registry.register(clientId, {
      transport: { send: vi.fn(), isOpen: () => true },
      abortController: new AbortController(),
      mode: 'agent',
      sessionId,
      cwd: root,
      sessionAllowList: new Set(),
    });
    chat.registry.get(clientId)!.inputQueue = { push, close: vi.fn() };
    chat.eventStore.upsertSession({ sessionId });

    await chat.sendToChat(clientId, 'first prompt', undefined, undefined, 'command-2');
    await expect(
      chat.sendToChat(clientId, 'changed prompt', undefined, undefined, 'command-2'),
    ).rejects.toThrow(/fingerprint/i);

    expect(responses.prepare).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledOnce();
  });
});
