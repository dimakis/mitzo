import { afterAll, afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createSessionMessagesHandler } from '../session-messages-route.js';
import type { StoredEvent } from '../event-store.js';
import { restoreOwnedVertexInitialPrompt } from '../ordinary-local-vertex-replay.js';
const owner = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vertex-replay-'));
  vi.stubEnv('REPO_PATH', root);
  return { remove: () => fs.rmSync(root, { recursive: true, force: true }) };
});
vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
const {
  eventStore,
  replayEventsToMessages,
  replayEventsToTranscript,
  getMessages,
  getSessionTranscript,
  getReconnectTranscript,
} = await import('../chat.js');
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  eventStore.close();
  owner.remove();
  vi.unstubAllEnvs();
});
const text = 'Read my budget';
const envelope = `Mitzo repository workspace offline: local/primary. Setup instructions.\n\n${text}`;
const events: StoredEvent[] = [
  { type: 'user_message', payload: { messageId: 'accepted', text } },
  { type: 'message_start', payload: { messageId: 'reply' } },
  { type: 'user_message', payload: { messageId: 'accepted', text: envelope } },
  { type: 'block_start', payload: { messageId: 'reply', blockId: 'b', blockType: 'text' } },
  { type: 'block_delta', payload: { messageId: 'reply', blockId: 'b', delta: 'Saved reply' } },
  { type: 'block_end', payload: { messageId: 'reply', blockId: 'b' } },
  { type: 'message_end', payload: { messageId: 'reply' } },
].map((event, index) => ({ ...event, seq: index + 1, createdAt: 1000, sessionId: 'saved' }));
const receipt = { sessionId: 'saved', commandId: 'accepted', text };
it('recovers both saved history and reconnect from the exact owned first-command duplicate without rewriting evidence', () => {
  const original = structuredClone(events);
  const restored = restoreOwnedVertexInitialPrompt(events, envelope, receipt);
  const transcript = replayEventsToTranscript(restored.events, restored.initialPrompt);
  for (const messages of [
    transcript.messages,
    replayEventsToMessages(restored.events, restored.initialPrompt),
  ]) {
    expect(messages.map((message) => message.messageId)).toEqual(['accepted', 'reply']);
    expect(messages[0].blocks[0].content).toBe(text);
    expect(messages[1].blocks[0].content).toBe('Saved reply');
  }
  expect(events).toEqual(original);
});
it.each([
  { sessionId: 'foreign', commandId: 'accepted', text },
  { sessionId: 'saved', commandId: 'other', text },
  { sessionId: 'saved', commandId: 'accepted', text: 'different' },
  undefined,
])('keeps unverified duplicates rejected rather than dropping history: %j', (receipt) => {
  const restored = restoreOwnedVertexInitialPrompt(events, envelope, receipt);
  expect(() => replayEventsToTranscript(restored.events, restored.initialPrompt)).toThrow(
    'duplicate',
  );
});
it('does not erase a conflicting later user message or an attributed event', () => {
  for (const patch of [{ text: 'different' }, { seatId: 'unverified' }]) {
    const changed = structuredClone(events);
    Object.assign(changed[2].payload, patch);
    const restored = restoreOwnedVertexInitialPrompt(changed, envelope, receipt);
    expect(() => replayEventsToTranscript(restored.events, restored.initialPrompt)).toThrow();
  }
});

it('serves the saved conversation over actual history and reconnect HTTP reads after an owned startup duplicate', async () => {
  vi.spyOn(eventStore, 'getSession').mockReturnValue({
    sessionId: 'saved',
    cwd: '/original-task',
    accountBinding: { provider: 'anthropic-vertex' },
    initialPrompt: envelope,
  } as never);
  vi.spyOn(eventStore, 'getOrdinaryLocalVertexCustody').mockReturnValue({
    initialCommandId: 'accepted',
  } as never);
  vi.spyOn(eventStore, 'getSendCommand').mockReturnValue({
    sessionId: 'saved',
    payload: { text },
  } as never);
  vi.spyOn(eventStore, 'getSessionEvents').mockReturnValue(events);
  vi.spyOn(eventStore, 'getSessionEventsThroughCursor').mockImplementation((_id, cursor) =>
    events.filter((event) => event.seq <= cursor),
  );
  const app = express();
  app.get(
    '/sessions/:id/messages',
    createSessionMessagesHandler({ getMessages, getSessionTranscript, getReconnectTranscript }),
  );
  for (const query of ['', '?transcript=1', '?throughSeq=7']) {
    const response = await request(app).get(`/sessions/saved/messages${query}`);
    expect(response.status).toBe(200);
    const messages = Array.isArray(response.body) ? response.body : response.body.messages;
    expect(messages.map((message: { messageId: string }) => message.messageId)).toEqual([
      'accepted',
      'reply',
    ]);
    expect(messages[0].blocks[0].content).toBe(text);
    expect(messages[1].blocks[0].content).toBe('Saved reply');
    if (query === '?transcript=1') expect(response.body.cursor).toBe(7);
  }
  const prefix = await request(app).get('/sessions/saved/messages?throughSeq=2');
  expect(prefix.status).toBe(200);
  expect(prefix.body.messages).toHaveLength(1);
  expect(JSON.stringify(prefix.body)).not.toContain('Saved reply');
});

it('restores the same owned startup duplicate when attached sources kept both echoes as public text', () => {
  const changed = structuredClone(events);
  changed[0].payload.sourceSnapshots = [{ kind: 'briefing', content: 'retained source' }];
  changed[2].payload.text = text;
  changed[2].payload.sourceSnapshots = structuredClone(changed[0].payload.sourceSnapshots);
  const restored = restoreOwnedVertexInitialPrompt(changed, text, receipt);
  const transcript = replayEventsToTranscript(restored.events, restored.initialPrompt);
  expect(transcript.messages.map((message) => message.messageId)).toEqual(['accepted', 'reply']);
  expect(restored.events[0].payload.sourceSnapshots).toEqual(changed[0].payload.sourceSnapshots);
});
it('does not hide conflicting attachments under an identical first-command identity', () => {
  const changed = structuredClone(events);
  changed[2].payload.text = text;
  changed[2].payload.images = ['different-image'];
  const restored = restoreOwnedVertexInitialPrompt(changed, text, receipt);
  expect(() => replayEventsToTranscript(restored.events, restored.initialPrompt)).toThrow(
    'duplicate',
  );
});
