import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexConversation } from '../codex-conversation.js';
import { CodexConversationStore } from '../codex-conversation-store.js';
import type { CodexLifecycleTransport } from '../codex-app-server-client.js';
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((f) => f());
});
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'mitzo-codex-'));
  const store = new CodexConversationStore(join(dir, 'private.db'));
  let callbacks!: CodexLifecycleTransport;
  let turn = 0;
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const events: Record<string, unknown>[] = [];
  const execute = vi.fn(
    async (_name: string, _input: Record<string, unknown>, _signal: AbortSignal) => ({
      content: 'ok',
      isError: false,
    }),
  );
  const rpc = {
    initialize: async () => {},
    close: vi.fn(),
    request: vi.fn(async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params });
      if (method === 'account/read')
        return { account: { type: 'chatgpt', email: 'test@example.com', planType: 'test' } };
      if (method === 'thread/start' || method === 'thread/resume')
        return { thread: { id: 'provider-thread' }, model: 'test-model', modelProvider: 'openai' };
      if (method === 'turn/start') {
        const id = `turn-${++turn}`;
        callbacks.onNotification('turn/started', { threadId: 'provider-thread', turn: { id } });
        return { turn: { id } };
      }
      if (method === 'turn/interrupt') {
        callbacks.onNotification('turn/completed', {
          threadId: 'provider-thread',
          turn: { id: `turn-${turn}`, status: 'interrupted' },
        });
        return {};
      }
      return {};
    }),
  };
  const c = new CodexConversation({
    conversationId: 'app',
    cwd: '/workspace',
    profile: {
      accountId: 'personal',
      accountLabel: 'ChatGPT',
      credentialRef: '/login',
      email: 'test@example.com',
      planType: 'test',
      model: 'test-model',
    },
    store,
    systemPrompt: 'context',
    tools: [{ name: 'Read', description: 'Read', input_schema: { type: 'object' } }],
    createClient: (cb) => {
      callbacks = cb;
      return rpc;
    },
    emit: (e) => events.push(e),
    executeTool: execute,
  });
  cleanup.push(() => {
    c.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await c.initialize();
  return { c, store, callbacks, rpc, requests, events, execute };
}
it('runs queued turns sequentially, rechecks account and never uses SDK/provider IDs as application IDs', async () => {
  const { c, callbacks, requests, events } = await setup();
  await c.send({ id: 'a', prompt: 'hello' });
  await c.send({ id: 'b', prompt: 'next' });
  expect(requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
  callbacks.onNotification('turn/completed', {
    threadId: 'provider-thread',
    turn: { id: 'turn-1', status: 'completed' },
  });
  await vi.waitFor(() => expect(requests.filter((r) => r.method === 'turn/start')).toHaveLength(2));
  expect(requests.filter((r) => r.method === 'account/read')).toHaveLength(3);
  expect(events.find((e) => e.type === 'system')).toMatchObject({ session_id: 'app' });
  await c.send({ id: 'b', prompt: 'next' });
  expect(requests.filter((r) => r.method === 'turn/start')).toHaveLength(2);
});
it('rejects account changes and unsupported skill ceilings before model execution', async () => {
  const { c, rpc, requests } = await setup();
  await expect(
    c.send({ id: 'skill', prompt: 'restricted', allowedTools: ['Read'] }),
  ).rejects.toThrow('skill');
  rpc.request.mockImplementation(async () => ({
    account: { type: 'chatgpt', email: 'other@example.com', planType: 'test' },
  }));
  await expect(c.send({ id: 'a', prompt: 'hello' })).rejects.toThrow('account');
  expect(requests.filter((r) => r.method === 'turn/start')).toHaveLength(0);
});
it('checks thread and turn identity, rejects unknown tools, and executes a duplicate call at most once', async () => {
  const { c, callbacks, execute } = await setup();
  await c.send({ id: 'a', prompt: 'read' });
  const input = {
    threadId: 'provider-thread',
    turnId: 'turn-1',
    callId: 'call',
    namespace: null,
    tool: 'Read',
    arguments: { file_path: 'note' },
  };
  const signal = new AbortController().signal;
  await expect(
    callbacks.onRequest('item/tool/call', { ...input, threadId: 'other' }, signal),
  ).rejects.toThrow('identity');
  await expect(
    callbacks.onRequest('item/tool/call', { ...input, tool: 'Unknown' }, signal),
  ).rejects.toThrow('tool');
  expect(await callbacks.onRequest('item/tool/call', input, signal)).toMatchObject({
    success: true,
  });
  expect(await callbacks.onRequest('item/tool/call', input, signal)).toMatchObject({
    success: false,
  });
  expect(execute).toHaveBeenCalledOnce();
});
it('interrupts the current turn, keeps queued follow-ups paused, and cancels a pending host tool', async () => {
  const { c, callbacks, execute, requests } = await setup();
  await c.send({ id: 'a', prompt: 'read' });
  await c.send({ id: 'b', prompt: 'next' });
  let toolSignal!: AbortSignal;
  execute.mockImplementation((_name, _input, signal) => {
    toolSignal = signal;
    return new Promise((resolve) =>
      signal.addEventListener('abort', () => resolve({ content: 'cancelled', isError: true })),
    );
  });
  const tool = callbacks.onRequest(
    'item/tool/call',
    {
      threadId: 'provider-thread',
      turnId: 'turn-1',
      callId: 'call',
      namespace: null,
      tool: 'Read',
      arguments: {},
    },
    new AbortController().signal,
  );
  await vi.waitFor(() => expect(toolSignal).toBeDefined());
  await c.interrupt();
  await tool;
  expect(toolSignal.aborted).toBe(true);
  expect(requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
  expect(c.queue().map((q) => q.status)).toEqual(['interrupted', 'queued']);
});
