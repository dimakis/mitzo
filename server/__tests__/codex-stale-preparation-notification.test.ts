import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexConversation, type CodexConversationOptions } from '../codex-conversation.js';
import { CodexConversationStore } from '../codex-conversation-store.js';
import type { CodexLifecycleTransport } from '../codex-app-server-client.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});

it('isolates queued preparation from stale starts while accepting synchronous starts for submitted turns', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-stale-preparation-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new CodexConversationStore(join(root, 'native.db'));
  cleanups.push(() => store.close());
  const binding = {
    accountId: 'offline',
    accountLabel: 'Offline',
    provider: 'openai' as const,
    model: 'fixture-model',
    profileRevision: 'offline-v1',
  };
  let callbacks!: CodexLifecycleTransport;
  let turn = 0;
  const started = (id: string) =>
    callbacks.onNotification('turn/started', {
      threadId: 'thread',
      turn: { id },
    });
  const rpc = {
    initialize: vi.fn(async () => {}),
    close: vi.fn(),
    request: vi.fn(async (method: string): Promise<unknown> => {
      if (method === 'config/read') return { config: {} };
      if (method === 'thread/start')
        return { thread: { id: 'thread' }, model: binding.model, modelProvider: 'openai' };
      if (method === 'turn/start') {
        const id = `turn-${++turn}`;
        if (turn === 2) started('turn-1');
        // The legitimate start can be delivered synchronously inside request().
        started(id);
        return { turn: { id } };
      }
      return {};
    }),
  };
  let hold = false,
    fail = false,
    preparing = false;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const options: CodexConversationOptions = {
    conversationId: 'chat',
    cwd: '/workspace',
    storedBinding: binding,
    profile: {
      accountId: 'offline',
      accountLabel: 'Offline',
      credentialRef: '/offline',
      email: 'offline@example.test',
      planType: 'test',
      model: binding.model,
    },
    store,
    systemPrompt: 'Offline test instructions',
    tools: [],
    emit: () => {},
    executeTool: async () => {
      throw Error('No live tools');
    },
    verifyBinding: async () => binding,
    transportClosure: 'terminal',
    canClaimCommand: () => true,
    createClient: (owner) => {
      callbacks = owner;
      return rpc;
    },
    prepareAgentContext: async () => {
      if (hold) {
        preparing = true;
        await barrier;
      }
      if (fail) {
        started('turn-2');
        started('unrequested-turn');
        callbacks.onNotification('turn/completed', {
          threadId: 'thread',
          turn: { id: 'unrequested-turn', status: 'completed' },
        });
        throw Error('Offline preparation refusal');
      }
    },
  };
  const conversation = new CodexConversation(options);
  cleanups.push(() => conversation.close());
  await conversation.initialize();
  const complete = (id: string) =>
    callbacks.onNotification('turn/completed', {
      threadId: 'thread',
      turn: { id, status: 'completed' },
    });
  await conversation.send({ id: 'first', prompt: 'First input' });
  complete('turn-1');
  hold = true;
  const second = conversation.send({ id: 'second', prompt: 'Queued steering' });
  await vi.waitFor(() => expect(preparing).toBe(true));
  started('turn-1');
  started('unrequested-turn');
  callbacks.onNotification('turn/completed', {
    threadId: 'thread',
    turn: { id: 'unrequested-turn', status: 'completed' },
  });
  release();
  await second;
  expect(turn).toBe(2);
  expect(store.commands('chat', binding).at(-1)).toMatchObject({ id: 'second', status: 'running' });
  complete('turn-2');
  hold = false;
  fail = true;
  await expect(conversation.send({ id: 'third', prompt: 'Retain this input' })).rejects.toThrow();
  expect(turn).toBe(2);
  expect(store.assertUndispatchedCommand('chat', binding, 'third')).toMatchObject({
    id: 'third',
    status: 'failed',
    attempt: 1,
  });
});
