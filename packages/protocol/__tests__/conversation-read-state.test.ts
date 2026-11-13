import { afterEach, expect, it } from 'vitest';
import { EventStore } from '../src/event-store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stores: EventStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
function setup() {
  const store = new EventStore(':memory:');
  stores.push(store);
  store.upsertSession({ sessionId: 'chat', conversationSource: 'mitzo' });
  return store;
}
function reply(store: EventStore, id: string, text = 'A reply') {
  store.append('chat', 'message_start', { messageId: id });
  store.append('chat', 'block_delta', { messageId: id, blockType: 'text', delta: text });
  return store.append('chat', 'message_end', { messageId: id });
}
it('tracks the latest completed visible reply, excluding tools, whitespace and streaming text', () => {
  const store = setup();
  const seq = reply(store, 'reply');
  reply(store, 'empty', '   ');
  for (const [index, text] of ['\n', '\t', '\r\n', '\u00a0', '\u2003', '\ufeff'].entries())
    reply(store, `whitespace-${index}`, text);
  store.append('chat', 'message_end', { messageId: 'tools-only' });
  store.append('chat', 'block_delta', {
    messageId: 'stream',
    blockType: 'text',
    delta: 'Still writing',
  });
  expect(store.getSessionReadState('chat')).toMatchObject({
    latestReplySeq: seq,
    readReplySeq: 0,
    markedUnread: false,
  });
});
it('acknowledges only the reply actually viewed and never clears a newer unseen reply', () => {
  const store = setup();
  const first = reply(store, 'first');
  const second = reply(store, 'second');
  expect(store.setSessionReadState('chat', { readReplySeq: first })).toMatchObject({
    latestReplySeq: second,
    readReplySeq: first,
    markedUnread: false,
  });
  expect(() => store.setSessionReadState('chat', { readReplySeq: second + 100 })).toThrow();
  store.setSessionReadState('chat', { readReplySeq: second });
  expect(store.setSessionReadState('chat', { markedUnread: true })).toMatchObject({
    markedUnread: true,
  });
  expect(store.setSessionReadState('chat', { readReplySeq: second })).toMatchObject({
    markedUnread: false,
  });
});
it('persists read markers without touching session freshness and rejects hidden or missing conversations', () => {
  const store = setup();
  const seq = reply(store, 'first');
  const before = store.getSession('chat')!.updatedAt;
  store.setSessionReadState('chat', { readReplySeq: seq });
  expect(store.getSession('chat')!.updatedAt).toBe(before);
  expect(store.getSessionReadState('chat').readReplySeq).toBe(seq);
  store.hideSession('chat');
  expect(() => store.setSessionReadState('chat', { markedUnread: true })).toThrow();
  expect(() => store.setSessionReadState('missing', { markedUnread: true })).toThrow();
});

it('retains manual unread through a database reopen and fences a stale acknowledgement', () => {
  const directory = mkdtempSync(join(tmpdir(), 'conversation-read-'));
  const path = join(directory, 'events.db');
  let store = new EventStore(path);
  try {
    store.upsertSession({ sessionId: 'chat', conversationSource: 'mitzo' });
    const seq = reply(store, 'first');
    store.setSessionReadState('chat', { readReplySeq: seq, expectedRevision: 0 });
    store.setSessionReadState('chat', { markedUnread: true, expectedRevision: 1 });
    store.close();
    store = new EventStore(path);
    expect(store.getSessionReadState('chat')).toMatchObject({
      latestReplySeq: seq,
      readReplySeq: seq,
      markedUnread: true,
      revision: 2,
    });
    expect(() =>
      store.setSessionReadState('chat', { readReplySeq: seq, expectedRevision: 1 }),
    ).toThrow('Read state changed');
    expect(store.getSessionReadState('chat').markedUnread).toBe(true);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
