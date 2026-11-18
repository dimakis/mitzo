import { expect, it, vi } from 'vitest';
import { replayUnstreamedAssistantMessages } from '../unstreamed-assistant-replay.js';

type Msg = Record<string, unknown>;

async function run(input: Msg[]) {
  const observer = { replayed: vi.fn(), suppressedLateStream: vi.fn() };
  async function* source() {
    yield* input;
  }
  const out: Msg[] = [];
  for await (const msg of replayUnstreamedAssistantMessages(source(), observer)) out.push(msg);
  return { out, observer };
}

const stream = (event: Msg, parent: string | null = null): Msg => ({
  type: 'stream_event',
  event,
  parent_tool_use_id: parent,
});
const assistant = (id: string | undefined, content: Msg[], extra: Msg = {}): Msg => ({
  type: 'assistant',
  parent_tool_use_id: null,
  session_id: 'native',
  message: { ...(id ? { id } : {}), model: 'claude-opus-5-5', content, ...extra },
});
const events = (out: Msg[]) =>
  out.map((msg) =>
    msg.type === 'stream_event' ? (msg.event as { type: string }).type : String(msg.type),
  );

it('passes streamed messages through unchanged', async () => {
  const input = [
    stream({ type: 'message_start', message: { id: 'msg_a' } }),
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    stream({ type: 'content_block_stop', index: 0 }),
    assistant('msg_a', [{ type: 'text', text: 'hi' }]),
  ];
  const { out, observer } = await run(input);
  expect(out).toEqual(input);
  expect(observer.replayed).not.toHaveBeenCalled();
});

it('replays a non-streamed reply as stream events ahead of its envelope', async () => {
  const envelope = assistant('msg_fallback', [
    { type: 'thinking', thinking: 'plan', signature: 'sig' },
    { type: 'text', text: 'Checking.' },
    { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
  ]);
  const { out, observer } = await run([envelope]);
  expect(events(out)).toEqual([
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'assistant',
  ]);
  expect(out.at(-1)).toBe(envelope);
  expect((out[0]!.event as Msg).message).toMatchObject({
    id: 'msg_fallback',
    model: 'claude-opus-5-5',
  });
  expect(out.slice(0, -1).every((msg) => msg.parent_tool_use_id === null)).toBe(true);
  expect(out[7]!.event).toEqual({
    type: 'content_block_start',
    index: 2,
    content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
  });
  expect(out[8]!.event).toEqual({
    type: 'content_block_delta',
    index: 2,
    delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' },
  });
  expect(observer.replayed).toHaveBeenCalledWith({
    messageId: 'msg_fallback',
    blockCount: 3,
    duplicateBlockCount: 0,
    skippedBlockTypes: [],
  });
});

it('continues indices without a second message_start for split envelopes', async () => {
  const { out } = await run([
    assistant('msg_split', [{ type: 'text', text: 'one' }]),
    assistant('msg_split', [{ type: 'tool_use', id: 'toolu_2', name: 'Read', input: {} }]),
  ]);
  expect(events(out).filter((type) => type === 'message_start')).toHaveLength(1);
  const starts = out.filter(
    (msg) => (msg.event as { type?: string } | undefined)?.type === 'content_block_start',
  );
  expect(starts.map((msg) => (msg.event as { index: number }).index)).toEqual([0, 1]);
});

it('drops a late stream, including its completing envelope, for a replayed message', async () => {
  const lateEnvelope = assistant('msg_late', [{ type: 'text', text: 'once' }]);
  const split = assistant('msg_late', [
    { type: 'tool_use', id: 'toolu_3', name: 'Read', input: {} },
  ]);
  const { out, observer } = await run([
    assistant('msg_late', [{ type: 'text', text: 'once' }]),
    stream({ type: 'message_start', message: { id: 'msg_late' } }),
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'once' } }),
    stream({ type: 'content_block_stop', index: 0 }),
    // The late stream completes with an envelope repeating the replayed block.
    lateEnvelope,
    // Its next block was never replayed: the envelope still adds it once.
    stream({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_3', name: 'Read', input: {} },
    }),
    stream({ type: 'content_block_stop', index: 1 }),
    split,
    stream({ type: 'message_start', message: { id: 'msg_next' } }),
  ]);
  expect(events(out)).toEqual([
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'assistant',
    'assistant',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'assistant',
    'message_start',
  ]);
  const deltas = out.filter(
    (msg) => (msg.event as { type?: string } | undefined)?.type === 'content_block_delta',
  );
  expect(deltas.map((msg) => (msg.event as { index: number }).index)).toEqual([0, 1]);
  expect(JSON.stringify(deltas).match(/once/g)).toHaveLength(1);
  expect(out[5]).toBe(lateEnvelope);
  expect((out.at(-1)!.event as Msg).message).toEqual({ id: 'msg_next' });
  expect(observer.suppressedLateStream).toHaveBeenCalledWith({ messageId: 'msg_late' });
  expect(observer.replayed).toHaveBeenCalledWith({
    messageId: 'msg_late',
    blockCount: 0,
    duplicateBlockCount: 1,
    skippedBlockTypes: [],
  });
});

it('keeps a late stream block whose text repeats an already replayed block', async () => {
  const same = { type: 'text', text: 'again' };
  const text = (index: number) => [
    stream({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }),
    stream({ type: 'content_block_stop', index }),
  ];
  const { out } = await run([
    assistant('msg_echo', [same]),
    stream({ type: 'message_start', message: { id: 'msg_echo' } }),
    ...text(0),
    assistant('msg_echo', [same]),
    ...text(1),
    assistant('msg_echo', [same]),
  ]);
  const deltas = out.filter(
    (msg) => (msg.event as { type?: string } | undefined)?.type === 'content_block_delta',
  );
  expect(deltas.map((msg) => (msg.event as { index: number }).index)).toEqual([0, 1]);
});

it('keeps legitimate identical blocks from separate envelopes', async () => {
  const same = { type: 'text', text: 'Checking.' };
  const { out, observer } = await run([
    assistant('msg_repeat', [same]),
    assistant('msg_repeat', [same]),
    assistant('msg_repeat', [same, same]),
  ]);
  const deltas = out.filter(
    (msg) => (msg.event as { type?: string } | undefined)?.type === 'content_block_delta',
  );
  expect(deltas.map((msg) => (msg.event as { index: number }).index)).toEqual([0, 1, 2, 3]);
  expect(
    deltas.every((msg) => (msg.event as { delta: { text: string } }).delta.text === 'Checking.'),
  ).toBe(true);
  expect(events(out).filter((type) => type === 'message_start')).toHaveLength(1);
  expect(observer.replayed).not.toHaveBeenCalledWith(
    expect.objectContaining({ duplicateBlockCount: 1 }),
  );
});

it.each([
  [
    'child agent envelopes',
    {
      ...assistant('msg_child', [{ type: 'text', text: 'x' }]),
      parent_tool_use_id: 'toolu_parent',
    },
  ],
  [
    'envelopes without an API identity (Codex)',
    assistant(undefined, [{ type: 'text', text: 'x' }]),
  ],
  [
    'CLI-synthesized notices',
    assistant('msg_synth', [{ type: 'text', text: 'x' }], { model: '<synthetic>' }),
  ],
  [
    'API error envelopes',
    { ...assistant('msg_err', [{ type: 'text', text: 'x' }]), isApiErrorMessage: true },
  ],
])('leaves %s alone', async (_name, envelope) => {
  const { out, observer } = await run([envelope]);
  expect(out).toEqual([envelope]);
  expect(observer.replayed).not.toHaveBeenCalled();
});

it('reports unsupported blocks and emits no empty message', async () => {
  const envelope = assistant('msg_server', [
    { type: 'server_tool_use', id: 'srv', name: 'web_search' },
  ]);
  const { out, observer } = await run([envelope]);
  expect(out).toEqual([envelope]);
  expect(observer.replayed).toHaveBeenCalledWith({
    messageId: 'msg_server',
    blockCount: 0,
    duplicateBlockCount: 0,
    skippedBlockTypes: ['server_tool_use'],
  });
});
