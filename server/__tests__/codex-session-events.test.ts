import { expect, it } from 'vitest';
import { CodexSessionEvents } from '../codex-session-events.js';
it('maps streamed text and completion using application identity and ignores other threads', () => {
  const events: Record<string, unknown>[] = [];
  const mapper = new CodexSessionEvents('app-id', 'provider-id', 'model', (e) => events.push(e));
  mapper.notification('item/agentMessage/delta', {
    threadId: 'other',
    itemId: 'i',
    delta: 'secret',
  });
  mapper.notification('item/agentMessage/delta', {
    threadId: 'provider-id',
    itemId: 'i',
    delta: 'hel',
  });
  mapper.notification('item/agentMessage/delta', {
    threadId: 'provider-id',
    itemId: 'i',
    delta: 'lo',
  });
  mapper.notification('item/completed', {
    threadId: 'provider-id',
    item: { type: 'agentMessage', id: 'i', text: 'hello' },
  });
  mapper.notification('turn/completed', {
    threadId: 'provider-id',
    turn: { id: 't', status: 'completed' },
  });
  expect(events.filter((e) => e.type === 'assistant')).toEqual([
    {
      type: 'assistant',
      session_id: 'app-id',
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: 'hello' }] },
    },
  ]);
  expect(events.filter((e) => e.type === 'result')).toEqual([
    { type: 'result', session_id: 'app-id' },
  ]);
  expect(JSON.stringify(events)).not.toContain('provider-id');
  expect(JSON.stringify(events)).not.toContain('secret');
  expect(
    events.filter((e) => e.type === 'stream_event').map((e) => (e.event as { type: string }).type),
  ).toEqual([
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_delta',
    'content_block_stop',
  ]);
});
it('handles final-only text, repeated completion, and flushes partial text on interruption', () => {
  const events: Record<string, unknown>[] = [];
  const m = new CodexSessionEvents('app', 'provider', 'model', (e) => events.push(e));
  const final = { threadId: 'provider', item: { id: 'i', type: 'agentMessage', text: 'done' } };
  m.notification('item/completed', final);
  m.notification('item/completed', final);
  expect(events.filter((e) => e.type === 'assistant')).toHaveLength(1);
  m.notification('item/agentMessage/delta', {
    threadId: 'provider',
    itemId: 'next',
    delta: 'partial',
  });
  m.notification('turn/completed', {
    threadId: 'provider',
    turn: { id: 'turn', status: 'interrupted' },
  });
  expect(events.filter((e) => e.type === 'assistant').at(-1)).toMatchObject({
    message: { content: [{ type: 'text', text: 'partial' }] },
  });
});
it('renders host tool calls and results without putting provider continuation IDs into public events', () => {
  const events: Record<string, unknown>[] = [];
  const m = new CodexSessionEvents('app', 'provider', 'model', (e) => events.push(e));
  const id = m.toolStart('provider-call', 'Read', { file_path: 'note' });
  m.toolResult(id, 'hello', false);
  expect(id).not.toBe('provider-call');
  expect(events).toContainEqual({
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: id, content: 'hello', is_error: false }],
    },
    parent_tool_use_id: null,
  });
});
