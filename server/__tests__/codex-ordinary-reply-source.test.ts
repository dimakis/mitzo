import { afterEach, expect, it, vi } from 'vitest';
import { CodexConversation, type CodexConversationOptions } from '../codex-conversation.js';
import { CodexConversationStore } from '../codex-conversation-store.js';
import type { CodexLifecycleTransport } from '../codex-app-server-client.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'mitzo-native-reply-'));
  const store = new CodexConversationStore(join(directory, 'private.db'));
  let callbacks!: CodexLifecycleTransport;
  let settle!: (response: unknown) => void;
  const sources = vi.fn();
  const events: Record<string, unknown>[] = [];
  const options: CodexConversationOptions = {
    conversationId: 'ordinary-app',
    cwd: '/fixture',
    profile: {
      accountId: 'personal',
      accountLabel: 'Fixture',
      credentialRef: '/offline-login',
      email: 'fixture@example.com',
      planType: 'test',
      model: 'offline-fixture',
    },
    store,
    systemPrompt: 'Fixture',
    tools: [],
    onProviderMessageSource: sources,
    createClient: (owner) => {
      callbacks = owner;
      return {
        initialize: async () => {},
        close: () => {},
        request: async (method) => {
          if (method === 'config/read') return { config: {} };
          if (method === 'account/read')
            return { account: { type: 'chatgpt', email: 'fixture@example.com', planType: 'test' } };
          if (method === 'thread/start')
            return {
              thread: { id: 'private-thread' },
              model: 'offline-fixture',
              modelProvider: 'openai',
            };
          if (method === 'turn/start')
            return new Promise((resolve) => {
              settle = resolve;
            });
          return {};
        },
      };
    },
    emit: (event) => events.push(event),
    executeTool: async () => ({ content: '', isError: false }),
  };
  const conversation = new CodexConversation(options);
  cleanup.push(() => {
    conversation.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await conversation.initialize();
  return {
    conversation,
    callbacks,
    sources,
    events,
    ready: () => vi.waitFor(() => expect(settle).toBeTypeOf('function')),
    acknowledge: (turnId = 'private-turn') => settle({ turn: { id: turnId } }),
    text: (itemId: string, turnId = 'private-turn') =>
      callbacks.onNotification('item/agentMessage/delta', {
        threadId: 'private-thread',
        turnId,
        itemId,
        delta: 'Attributed text',
      }),
  };
}

it('binds generated visible text IDs to the exact command only after its provider ACK', async () => {
  const f = await fixture();
  const pending = f.conversation.send({ id: 'ordinary-command', prompt: 'Review' });
  await f.ready();
  f.text('private-item');
  expect(f.sources).not.toHaveBeenCalled();
  f.acknowledge();
  await pending;
  const event = f.events.find(
    (event) =>
      event.type === 'stream_event' && (event.event as { type: string }).type === 'message_start',
  )!;
  const messageId = (event.event as { message: { id: string } }).message.id;
  expect(f.sources).toHaveBeenCalledExactlyOnceWith({
    commandId: 'ordinary-command',
    messageId,
    providerThreadId: 'private-thread',
    providerTurnId: 'private-turn',
  });
  expect(JSON.stringify(event)).not.toContain('private-turn');
  f.text('private-item');
  expect(f.sources).toHaveBeenCalledTimes(1);
});

it('binds later text after ACK, while excluding stale turns, foreign threads, thinking and tools', async () => {
  const f = await fixture();
  const pending = f.conversation.send({ id: 'ordinary-command', prompt: 'Review' });
  await f.ready();
  f.acknowledge();
  await pending;
  f.text('stale-item', 'stale-turn');
  f.callbacks.onNotification('item/agentMessage/delta', {
    threadId: 'foreign',
    turnId: 'private-turn',
    itemId: 'foreign-item',
    delta: 'No',
  });
  f.callbacks.onNotification('item/reasoning/summaryTextDelta', {
    threadId: 'private-thread',
    turnId: 'private-turn',
    itemId: 'thinking',
    summaryIndex: 0,
    delta: 'Private',
  });
  f.callbacks.onNotification('item/started', {
    threadId: 'private-thread',
    turnId: 'private-turn',
    item: { id: 'tool', type: 'commandExecution', command: 'pwd' },
  });
  expect(f.sources).not.toHaveBeenCalled();
  f.text('correct-item');
  expect(f.sources).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      commandId: 'ordinary-command',
      providerTurnId: 'private-turn',
      providerThreadId: 'private-thread',
    }),
  );
});

it('does not adopt output from a different turn when the ACK arrives or infer absent turn identity', async () => {
  const f = await fixture();
  const pending = f.conversation.send({ id: 'ordinary-command', prompt: 'Review' });
  await f.ready();
  f.text('stale-item', 'different-turn');
  f.callbacks.onNotification('item/agentMessage/delta', {
    threadId: 'private-thread',
    itemId: 'missing-turn',
    delta: 'Unmapped',
  });
  f.acknowledge();
  await pending;
  expect(f.sources).not.toHaveBeenCalled();
});

it('leaves output unmapped after an uncertain transport close', async () => {
  const f = await fixture();
  const pending = f.conversation.send({ id: 'ordinary-command', prompt: 'Review' });
  await f.ready();
  f.text('unconfirmed-item');
  f.callbacks.onClose(new Error('Lost provider ACK'));
  f.acknowledge();
  await pending.catch(() => {});
  expect(f.sources).not.toHaveBeenCalled();
});

it.each(['stale-turn', undefined])(
  'rejects reused-item deltas and completion with %s turn identity after ACK',
  async (turnId) => {
    const f = await fixture();
    const pending = f.conversation.send({ id: 'ordinary-command', prompt: 'Review' });
    await f.ready();
    f.acknowledge();
    await pending;
    f.text('shared-item');
    f.callbacks.onNotification('item/agentMessage/delta', {
      threadId: 'private-thread',
      turnId,
      itemId: 'shared-item',
      delta: 'FOREIGN TEXT',
    });
    f.callbacks.onNotification('item/completed', {
      threadId: 'private-thread',
      turnId,
      item: { id: 'shared-item', type: 'agentMessage', text: 'FOREIGN TEXT' },
    });
    expect(f.events.filter((event) => event.type === 'assistant')).toHaveLength(0);
    expect(JSON.stringify(f.events)).not.toContain('FOREIGN TEXT');
    f.callbacks.onNotification('item/completed', {
      threadId: 'private-thread',
      turnId: 'private-turn',
      item: { id: 'shared-item', type: 'agentMessage', text: 'Attributed text' },
    });
    expect(f.events.filter((event) => event.type === 'assistant')).toEqual([
      expect.objectContaining({
        message: { content: [{ type: 'text', text: 'Attributed text' }] },
      }),
    ]);
    expect(f.sources).toHaveBeenCalledTimes(1);
  },
);

it('rejects reused-item foreign text before ACK and preserves the exact eventual binding', async () => {
  const f = await fixture();
  const pending = f.conversation.send({ id: 'ordinary-command', prompt: 'Review' });
  await f.ready();
  f.text('shared-item');
  f.callbacks.onNotification('item/agentMessage/delta', {
    threadId: 'private-thread',
    turnId: 'other-turn',
    itemId: 'shared-item',
    delta: 'FOREIGN BEFORE ACK',
  });
  f.callbacks.onNotification('item/completed', {
    threadId: 'private-thread',
    turnId: 'other-turn',
    item: { id: 'shared-item', type: 'agentMessage', text: 'FOREIGN BEFORE ACK' },
  });
  expect(f.sources).not.toHaveBeenCalled();
  expect(f.events.filter((event) => event.type === 'assistant')).toHaveLength(0);
  expect(JSON.stringify(f.events)).not.toContain('FOREIGN BEFORE ACK');
  f.acknowledge();
  await pending;
  f.callbacks.onNotification('item/completed', {
    threadId: 'private-thread',
    turnId: 'private-turn',
    item: { id: 'shared-item', type: 'agentMessage', text: 'Attributed text' },
  });
  expect(f.sources).toHaveBeenCalledTimes(1);
  expect(f.events.filter((event) => event.type === 'assistant')).toHaveLength(1);
});

it('does not let a reused reasoning key mutate a mapped text item', async () => {
  const f = await fixture();
  const pending = f.conversation.send({ id: 'ordinary-command', prompt: 'Review' });
  await f.ready();
  f.acknowledge();
  await pending;
  f.text('reasoning:collision:0');
  f.callbacks.onNotification('item/reasoning/summaryTextDelta', {
    threadId: 'private-thread',
    turnId: 'private-turn',
    itemId: 'collision',
    summaryIndex: 0,
    delta: 'PRIVATE REASONING',
  });
  expect(JSON.stringify(f.events)).not.toContain('PRIVATE REASONING');
  f.callbacks.onNotification('item/completed', {
    threadId: 'private-thread',
    turnId: 'private-turn',
    item: { id: 'reasoning:collision:0', type: 'agentMessage', text: 'Attributed text' },
  });
  expect(f.events.filter((event) => event.type === 'assistant')).toEqual([
    expect.objectContaining({ message: { content: [{ type: 'text', text: 'Attributed text' }] } }),
  ]);
});
