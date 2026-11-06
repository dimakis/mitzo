import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../event-store.js';
import { replayEventsToMessages, replayEventsToTranscript } from '../conversation-transcript.js';
import { parseServerMessage } from '../../packages/client/src/protocol-parser.js';
import {
  INITIAL_MESSAGES_STATE,
  messagesReducer,
} from '../../packages/client/src/slices/messages.js';
import { watchAgentMessageTranscript } from '../agent-message-transcript.js';
import { SessionRegistry, ConnectionRegistry } from '@mitzo/harness';
import { deliverRetainedSessionEvent } from '../query-loop.js';

const stores: EventStore[] = [];
const roots: string[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

it('delivers live receipts through V2 watch and reconnect subscribers without legacy observers', async () => {
  const store = new EventStore(':memory:');
  stores.push(store);
  const sessions = new SessionRegistry();
  const connections = new ConnectionRegistry();
  const original = { isOpen: () => true, send: vi.fn() };
  const reconnected = { isOpen: () => true, send: vi.fn() };
  for (const id of ['a', 'b']) store.upsertSession({ sessionId: id });
  sessions.register('driver', {
    sessionId: 'b',
    transport: { isOpen: () => false, send: vi.fn() },
    abortController: new AbortController(),
    mode: 'agent',
    sessionAllowList: new Set(),
  });
  connections.register('tab', original);
  connections.watch('tab', 'b');
  const unwatch = watchAgentMessageTranscript(store, 'b', (event) =>
    deliverRetainedSessionEvent(event, 'driver', sessions, connections),
  );
  try {
    const sent = store.agentCommunication.reserve(
      'a',
      'operator',
      { turnId: 'turn', callId: 'call' },
      {
        requestId: randomUUID(),
        recipientConversationId: 'b',
        text: 'Every watching tab sees this receipt.',
      },
    );
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(original.send).toHaveBeenCalledOnce();
    connections.remove('tab');
    connections.register('reconnected-tab', reconnected);
    connections.watch('reconnected-tab', 'b');
    store.agentCommunication.recordForHost(sent.messageId, 'delivered');
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(original.send).toHaveBeenCalledOnce();
    expect(reconnected.send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        type: 'agent_message',
        sessionId: 'b',
        projection: expect.objectContaining({
          message: expect.objectContaining({ status: 'delivered' }),
        }),
      }),
    );
    expect(sessions.get('driver')!.observers.size).toBe(0);
  } finally {
    unwatch();
    sessions.dispose();
    connections.dispose();
  }
});

it('backfills retained invisible messages once on upgrade without attempting delivery', () => {
  const root = mkdtempSync(join(tmpdir(), 'peer-transcript-upgrade-'));
  roots.push(root);
  const path = join(root, 'events.db');
  const original = new EventStore(path);
  for (const id of ['a', 'b']) original.upsertSession({ sessionId: id });
  const sent = original.agentCommunication.reserve(
    'a',
    'operator',
    { turnId: 'turn', callId: 'call' },
    {
      requestId: randomUUID(),
      recipientConversationId: 'b',
      text: 'Retained but previously invisible',
    },
  );
  original.agentCommunication.claim(sent.messageId);
  original.close();
  const old = new Database(path);
  old.exec("DELETE FROM events WHERE type='agent_message'");
  if (
    (old.pragma('table_info(agent_communication_messages)') as Array<{ name: string }>).some(
      (column) => column.name === 'transcript_projected',
    )
  )
    old.exec('ALTER TABLE agent_communication_messages DROP COLUMN transcript_projected');
  old.close();
  const upgraded = new EventStore(path);
  stores.push(upgraded);
  const messages = replayEventsToMessages(upgraded.getSessionEvents('b'));
  expect(messages).toHaveLength(1);
  expect(messages[0].agentMessage?.message).toMatchObject({
    messageId: sent.messageId,
    status: 'uncertain',
  });
  expect(upgraded.agentCommunication.read('a', sent.messageId).status).toBe('uncertain');
});

it('publishes the same durable events live and stops watching when the owner closes', async () => {
  const store = new EventStore(':memory:');
  stores.push(store);
  for (const id of ['a', 'b']) store.upsertSession({ sessionId: id });
  const published: Record<string, unknown>[] = [];
  const unwatch = watchAgentMessageTranscript(store, 'b', (event) => published.push(event));
  const reads = vi.spyOn(store, 'getEventsAfter');
  const sent = store.agentCommunication.reserve(
    'a',
    'operator',
    { turnId: 'turn', callId: 'call' },
    { requestId: randomUUID(), recipientConversationId: 'b', text: 'Visible immediately' },
  );
  store.agentCommunication.claim(sent.messageId);
  store.agentCommunication.recordForHost(sent.messageId, 'queued');
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  expect(published).toHaveLength(3);
  expect(reads).toHaveBeenCalledTimes(1);
  expect(
    published.every(
      (event) =>
        event.type === 'agent_message' &&
        event.sessionId === 'b' &&
        Number.isSafeInteger(event.seq),
    ),
  ).toBe(true);
  unwatch();
  store.agentCommunication.recordForHost(sent.messageId, 'delivered');
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  expect(published).toHaveLength(3);
  expect(reads).toHaveBeenCalledTimes(1);
});

it('does not lose a receipt update created during a coalesced wakeup', async () => {
  const store = new EventStore(':memory:');
  stores.push(store);
  for (const id of ['a', 'b']) store.upsertSession({ sessionId: id });
  const seen: string[] = [];
  const sent = store.agentCommunication.reserve(
    'a',
    'operator',
    { turnId: 'turn', callId: 'call' },
    { requestId: randomUUID(), recipientConversationId: 'b', text: 'Retain every receipt' },
  );
  const unwatch = store.agentCommunication.subscribe('b', () => {
    seen.push(store.agentCommunication.read('b', sent.messageId).status);
    if (seen.length === 1) store.agentCommunication.recordForHost(sent.messageId, 'delivered');
  });
  store.agentCommunication.claim(sent.messageId);
  store.agentCommunication.recordForHost(sent.messageId, 'queued');
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(seen).toEqual(['queued', 'delivered']);
  expect(
    store.getSessionEvents('b').filter((event) => event.type === 'agent_message'),
  ).toHaveLength(4);
  unwatch();
});

it('shows every send in both transcripts before delivery, with exact text and durable status after replay', () => {
  const store = new EventStore(':memory:');
  stores.push(store);
  for (const id of ['sender', 'recipient', 'unrelated'])
    store.upsertSession({ sessionId: id, summary: `${id} chat` });
  const input = {
    requestId: randomUUID(),
    recipientConversationId: 'recipient',
    text: 'Pause PR work.\nKeep this exact message visible.',
  };
  const sent = store.agentCommunication.reserve(
    'sender',
    'operator',
    { turnId: 'turn', callId: 'call' },
    input,
  );
  expect(
    store.getSessionEvents('sender').filter((event) => event.type === 'agent_message'),
  ).toHaveLength(1);
  expect(
    store.getSessionEvents('recipient').filter((event) => event.type === 'agent_message'),
  ).toHaveLength(1);
  store.agentCommunication.claim(sent.messageId);
  store.agentCommunication.recordForHost(sent.messageId, 'queued');
  store.append('recipient', 'message_start', { messageId: 'running-answer' });
  store.append('recipient', 'block_start', { blockId: 'answer', blockType: 'text' });
  store.append('recipient', 'block_delta', {
    blockId: 'answer',
    blockType: 'text',
    delta: 'Still working',
  });
  store.agentCommunication.recordForHost(sent.messageId, 'delivered');
  const cursor = store.getSessionEventCursor('recipient');
  store.agentCommunication.recordForHost(sent.messageId, 'delivered');
  store.agentCommunication.reserve('sender', 'operator', { turnId: 'turn', callId: 'call' }, input);
  expect(store.getSessionEventCursor('recipient')).toBe(cursor);
  for (const [id, direction] of [
    ['sender', 'outgoing'],
    ['recipient', 'incoming'],
  ]) {
    const events = store.getSessionEvents(id);
    const replay = replayEventsToMessages(events).filter((message) => message.agentMessage);
    expect(replay).toHaveLength(1);
    expect(replay[0]).toMatchObject({
      role: 'assistant',
      agentMessage: { direction, message: { ...sent, status: 'delivered' } },
    });
    expect(replay[0].blocks[0].content).toBe(input.text);
    const bounded = replayEventsToTranscript(events);
    expect(bounded.messages.filter((message) => message.agentMessage)).toEqual(replay);
    if (id === 'recipient') expect(bounded.current?.messageId).toBe('running-answer');
    let state = INITIAL_MESSAGES_STATE;
    for (const event of events) {
      const parsed = parseServerMessage(
        { ...event.payload, type: event.type, seq: event.seq },
        { currentSessionId: id },
        { onSessionAssigned: vi.fn(), onSessionExpired: vi.fn() },
        id,
      );
      for (const action of parsed.messagesActions) state = messagesReducer(state, action);
    }
    expect(state.messages.filter((message) => message.agentMessage)).toEqual(replay);
  }
  expect(store.getSessionEvents('unrelated')).toEqual([]);
});

it('retains a failed send visibly without pretending delivery or disclosing private call provenance', () => {
  const store = new EventStore(':memory:');
  stores.push(store);
  for (const id of ['a', 'b']) store.upsertSession({ sessionId: id });
  const sent = store.agentCommunication.reserve(
    'a',
    'PRIVATE-operator',
    { turnId: 'PRIVATE-turn', callId: 'PRIVATE-call' },
    { requestId: randomUUID(), recipientConversationId: 'b', text: 'A message that could not run' },
  );
  store.agentCommunication.claim(sent.messageId);
  store.agentCommunication.recordForHost(sent.messageId, 'failed', 'cancelled');
  const transcript = replayEventsToMessages(store.getSessionEvents('b'));
  expect(transcript[0].agentMessage?.message.status).toBe('failed');
  expect(JSON.stringify(transcript)).not.toContain('PRIVATE-');
});
