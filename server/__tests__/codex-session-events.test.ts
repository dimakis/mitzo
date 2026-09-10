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
    { type: 'result', session_id: 'app-id', is_error: false },
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
it('reports provider token usage without double-counting cached input', () => {
  const events: Record<string, unknown>[] = [];
  const mapper = new CodexSessionEvents('app', 'provider', 'model', (event) => events.push(event));
  mapper.notification('thread/tokenUsage/updated', {
    threadId: 'provider',
    turnId: 'turn',
    tokenUsage: {
      last: { inputTokens: 100, cachedInputTokens: 70, outputTokens: 20 },
      total: {},
    },
  });
  mapper.notification('turn/completed', {
    threadId: 'provider',
    turn: { id: 'turn', status: 'completed' },
  });
  expect(events.at(-1)).toMatchObject({
    type: 'result',
    usage: { input_tokens: 30, cache_read_input_tokens: 70, output_tokens: 20 },
  });
});
it('renders host tool calls and results without putting provider continuation IDs into public events', () => {
  const events: Record<string, unknown>[] = [];
  const m = new CodexSessionEvents('app', 'provider', 'model', (e) => events.push(e));
  const id = m.toolStart('provider-call', 'Read', { file_path: 'note' });
  m.toolResult(id, 'hello', false);
  expect(id).not.toBe('provider-call');
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'stream_event',
      event: expect.objectContaining({
        type: 'content_block_start',
        content_block: { type: 'tool_use', id, name: 'Read', input: {} },
      }),
    }),
  );
  expect(events).toContainEqual({
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: id, content: 'hello', is_error: false }],
    },
    parent_tool_use_id: null,
  });
});

it('renders built-in command execution items as shell tool calls and results', () => {
  const events: Record<string, unknown>[] = [];
  const m = new CodexSessionEvents('app', 'provider', 'model', (event) => events.push(event));
  m.notification('item/started', {
    threadId: 'provider',
    item: {
      type: 'commandExecution',
      id: 'provider-command',
      command: 'pwd',
      cwd: '/sandbox/workspaces/mgmt',
    },
  });
  m.notification('item/completed', {
    threadId: 'provider',
    item: {
      type: 'commandExecution',
      id: 'provider-command',
      status: 'completed',
      aggregatedOutput: '/sandbox/workspaces/mgmt\n',
      exitCode: 0,
    },
  });
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'stream_event',
      event: expect.objectContaining({
        type: 'content_block_start',
        content_block: expect.objectContaining({ type: 'tool_use', name: 'Bash' }),
      }),
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'user',
      message: { content: [expect.objectContaining({ type: 'tool_result', is_error: false })] },
    }),
  );
  expect(JSON.stringify(events)).not.toContain('provider-command');
});

it('renders sandbox-native MCP and web search items as tool calls and results', () => {
  const events: Record<string, unknown>[] = [];
  const m = new CodexSessionEvents('app', 'provider', 'model', (event) => events.push(event));
  m.notification('item/started', {
    threadId: 'provider',
    item: {
      type: 'mcpToolCall',
      id: 'private-mcp-id',
      server: 'docs',
      tool: 'lookup',
      arguments: { document: 'synthetic' },
    },
  });
  m.notification('item/completed', {
    threadId: 'provider',
    item: {
      type: 'mcpToolCall',
      id: 'private-mcp-id',
      status: 'completed',
      result: { content: [{ type: 'text', text: 'fixture result' }] },
    },
  });
  m.notification('item/started', {
    threadId: 'provider',
    item: { type: 'webSearch', id: 'private-search-id', query: 'synthetic query' },
  });
  m.notification('item/completed', {
    threadId: 'provider',
    item: {
      type: 'webSearch',
      id: 'private-search-id',
      query: 'synthetic query',
      action: { type: 'search', query: 'synthetic query' },
    },
  });

  const serialized = JSON.stringify(events);
  expect(serialized).toContain('mcp__docs__lookup');
  expect(serialized).toContain('WebSearch');
  expect(serialized).toContain('fixture result');
  expect(serialized).toContain('synthetic query');
  expect(serialized).not.toContain('private-mcp-id');
  expect(serialized).not.toContain('private-search-id');
  expect(events.filter((event) => event.type === 'user')).toHaveLength(2);
});

it('renders provider reasoning summaries as thinking without exposing raw reasoning', () => {
  const events: Record<string, unknown>[] = [];
  const m = new CodexSessionEvents('app', 'provider', 'model', (e) => events.push(e));
  m.notification('item/reasoning/textDelta', {
    threadId: 'provider',
    itemId: 'r',
    delta: 'private raw reasoning',
  });
  m.notification('item/reasoning/summaryTextDelta', {
    threadId: 'provider',
    itemId: 'r',
    summaryIndex: 0,
    delta: 'Checking ',
  });
  m.notification('item/reasoning/summaryTextDelta', {
    threadId: 'provider',
    itemId: 'r',
    summaryIndex: 0,
    delta: 'the file',
  });
  m.notification('item/completed', {
    threadId: 'provider',
    item: {
      type: 'reasoning',
      id: 'r',
      summary: ['Checking the file'],
      content: ['private raw reasoning'],
    },
  });
  m.notification('turn/completed', { threadId: 'provider', turn: { id: 't' } });
  expect(events.filter((e) => e.type === 'assistant')).toEqual([
    expect.objectContaining({
      message: { content: [{ type: 'thinking', thinking: 'Checking the file' }] },
    }),
  ]);
  expect(JSON.stringify(events)).not.toContain('private raw reasoning');
});

it('drops late item events after a result and accepts them after the next turn starts', () => {
  const events: Record<string, unknown>[] = [];
  const m = new CodexSessionEvents('app', 'provider', 'model', (event) => events.push(event));
  m.notification('turn/completed', {
    threadId: 'provider',
    turn: { id: 'first', status: 'completed' },
  });
  const afterResult = events.length;
  m.notification('item/reasoning/summaryTextDelta', {
    threadId: 'provider',
    itemId: 'late',
    summaryIndex: 0,
    delta: 'too late',
  });
  m.notification('item/started', {
    threadId: 'provider',
    item: {
      type: 'commandExecution',
      id: 'late-command',
      command: 'must-not-render',
    },
  });
  m.notification('item/completed', {
    threadId: 'provider',
    item: {
      type: 'commandExecution',
      id: 'late-command',
      status: 'completed',
      aggregatedOutput: 'must-not-render',
      exitCode: 0,
    },
  });
  expect(events).toHaveLength(afterResult);
  m.notification('turn/started', { threadId: 'provider', turn: { id: 'second' } });
  m.notification('item/reasoning/summaryTextDelta', {
    threadId: 'provider',
    itemId: 'current',
    summaryIndex: 0,
    delta: 'current summary',
  });
  expect(events.length).toBeGreaterThan(afterResult);
  expect(JSON.stringify(events)).not.toContain('too late');
  expect(JSON.stringify(events)).not.toContain('must-not-render');
  expect(JSON.stringify(events)).toContain('current summary');
});
