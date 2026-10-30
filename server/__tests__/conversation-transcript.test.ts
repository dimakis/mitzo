import { afterEach, expect, it, vi } from 'vitest';
import * as protocol from '@mitzo/protocol';
import type { StoredEvent } from '@mitzo/protocol';
import {
  reconstructMessages,
  replayEventsToMessages,
  replayEventsToTranscript,
} from '../conversation-transcript.js';

// Pure projection must remain usable without constructing chat runtimes or stores.
vi.mock('../chat.js', () => {
  throw new Error('Transcript projection imported chat runtime');
});
afterEach(() => vi.restoreAllMocks());

it('parses legacy SDK blocks once while attaching a later tool result', () => {
  const parse = vi.spyOn(protocol, 'parseContentBlocks');
  const result = reconstructMessages([
    {
      type: 'assistant',
      message: {
        id: 'assistant',
        content: [
          { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: '/workspace/file' } },
        ],
      },
    },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'found' }] },
    },
  ]);
  expect(parse).toHaveBeenCalledTimes(2);
  expect(result).toMatchObject([
    { messageId: 'assistant', blocks: [{ toolResult: 'found', toolError: false }] },
  ]);
});

function history(turns: number): StoredEvent[] {
  const events: StoredEvent[] = [];
  const add = (type: string, payload: Record<string, unknown>) =>
    events.push({
      type,
      payload,
      seq: events.length + 1,
      sessionId: 'session',
      createdAt: events.length,
    });
  for (let i = 0; i < turns; i++) {
    const messageId = `message-${i}`;
    add('message_start', { messageId });
    add('block_start', { messageId, blockId: 'b0', blockType: 'tool_use' });
    add('block_end', { messageId, blockId: 'b0', blockType: 'tool_use', toolId: `tool-${i}` });
    add('message_end', { messageId });
    add('session_end', {});
    add('session_end', {});
  }
  return events;
}

for (const [name, project] of [
  ['history', replayEventsToMessages],
  ['reconnect', (events: StoredEvent[]) => replayEventsToTranscript(events).messages],
] as const) {
  it.each([1, 10, 100])(`${name} visits each terminal message once across %i turns`, (turns) => {
    const events = history(turns);
    const original = structuredClone(events);
    const interrupt = vi.spyOn(protocol, 'interruptUnansweredToolBlocks');
    const messages = project(events);
    expect(interrupt).toHaveBeenCalledTimes(turns);
    expect(messages).toHaveLength(turns);
    expect(messages.every((m) => m.blocks[0].toolInterrupted)).toBe(true);
    expect(events).toEqual(original);
  });

  it(`${name} preserves delayed results and does not terminalize the next unfinished turn`, () => {
    const events = history(10);
    const add = (type: string, payload: Record<string, unknown>) =>
      events.push({
        type,
        payload,
        seq: events.length + 1,
        sessionId: 'session',
        createdAt: events.length,
      });
    add('tool_result', { messageId: 'message-0', toolId: 'tool-0', result: '', isError: false });
    add('message_start', { messageId: 'active' });
    add('block_start', { messageId: 'active', blockId: 'b0', blockType: 'tool_use' });
    add('block_end', { messageId: 'active', blockId: 'b0', blockType: 'tool_use', toolId: 'next' });
    const messages = project(events);
    expect(messages[0].blocks[0]).toMatchObject({ toolResult: '', toolError: false });
    expect(messages[0].blocks[0]).not.toHaveProperty('toolInterrupted');
    expect(replayEventsToTranscript(events).current?.blocks[0]).not.toHaveProperty(
      'toolInterrupted',
    );
    if (name === 'history')
      expect(messages.at(-1)?.blocks[0]).not.toHaveProperty('toolInterrupted');
  });
}
