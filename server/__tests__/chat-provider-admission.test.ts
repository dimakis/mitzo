import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const responses = vi.hoisted(() => ({
  prepare: vi.fn(),
  track: vi.fn(),
  interrupt: vi.fn(),
}));

vi.mock('../responses-chat-session.js', () => ({
  getResponsesRuntime: () => responses,
  openResponsesChat: vi.fn(),
  trackResponsesProviderAdmission: responses.track,
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
    responses.track.mockReset();
    responses.interrupt.mockReset();
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

  it('reuses admission when identical images are restaged under different paths', async () => {
    const push = vi.fn();
    const sessionId = 'session-images';
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
    const images = [{ data: Buffer.from('same-image').toString('base64'), mediaType: 'image/png' }];
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValueOnce(1_000).mockReturnValueOnce(2_000);

    try {
      await expect(
        chat.sendToChat(clientId, 'inspect this', images, undefined, 'command-images'),
      ).resolves.toBe(true);
      await expect(
        chat.sendToChat(clientId, 'inspect this', images, undefined, 'command-images'),
      ).resolves.toBe(true);
    } finally {
      now.mockRestore();
    }

    expect(responses.prepare).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledOnce();
  });

  it('does not create an execution when a legacy transcript message already exists', async () => {
    const push = vi.fn();
    const sessionId = 'session-legacy';
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
    chat.eventStore.append(sessionId, 'user_message', {
      v: 2,
      type: 'user_message',
      ts: Date.now(),
      messageId: 'legacy-command',
      text: 'already stored',
    });

    await expect(
      chat.sendToChat(clientId, 'already stored', undefined, undefined, 'legacy-command'),
    ).resolves.toBe(true);

    expect(responses.prepare).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(chat.eventStore.getExecutionAdmission(sessionId, 'legacy-command')).toBeUndefined();
  });

  it('admits active provider sends that use a server-generated message ID', async () => {
    const push = vi.fn();
    const sessionId = 'session-generated-id';
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

    await expect(chat.sendToChat(clientId, 'generated identity')).resolves.toBe(true);

    const queued = push.mock.calls[0][0] as {
      mitzoMessageId: string;
      providerAdmission?: { token: { sessionId: string } };
    };
    expect(queued.providerAdmission?.token.sessionId).toBe(sessionId);
    expect(chat.eventStore.getExecutionAdmission(sessionId, queued.mitzoMessageId)).toBeDefined();
  });

  it('terminalizes and clears preparation when acknowledgement throws', async () => {
    const sessionId = 'session-ack-failure';
    chat.registry.register(clientId, {
      transport: {
        send: vi.fn(() => {
          throw new Error('socket closed');
        }),
        isOpen: () => true,
      },
      abortController: new AbortController(),
      mode: 'agent',
      sessionId,
      cwd: root,
      sessionAllowList: new Set(),
    });
    chat.registry.get(clientId)!.inputQueue = { push: vi.fn(), close: vi.fn() };
    chat.eventStore.upsertSession({ sessionId });

    await expect(
      chat.sendToChat(clientId, 'cannot acknowledge', undefined, undefined, 'ack-failure'),
    ).rejects.toThrow('socket closed');

    expect(responses.interrupt).toHaveBeenCalledOnce();
    expect(chat.eventStore.getSession(sessionId)).toMatchObject({
      executionPhase: 'TERMINAL',
      executionTerminalReason: 'startup_failed',
    });
  });

  it('rejects a retry when resolved context-block content changes', async () => {
    const push = vi.fn();
    const sessionId = 'session-context-change';
    const contextPath = join(root, 'context.md');
    writeFileSync(contextPath, 'first context');
    writeFileSync(
      join(root, '.mitzo.json'),
      JSON.stringify({ contextBlocks: { attached: 'context.md' } }),
    );
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
    const now = vi.spyOn(Date, 'now').mockReturnValue(9_000_000_000_000_000);

    try {
      await chat.sendToChat(clientId, 'use context', undefined, ['attached'], 'context-command');
      writeFileSync(contextPath, 'changed context');
      now.mockReturnValue(9_000_000_000_006_000);
      await expect(
        chat.sendToChat(clientId, 'use context', undefined, ['attached'], 'context-command'),
      ).rejects.toThrow(/fingerprint/i);
    } finally {
      now.mockRestore();
    }

    expect(responses.prepare).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledOnce();
  });
});
