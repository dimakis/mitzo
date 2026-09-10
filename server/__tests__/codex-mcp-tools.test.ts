import { expect, it, vi } from 'vitest';
import { connectCodexMcpTools } from '../codex-mcp-tools.js';

it('never launches sandbox-only MCP definitions on the host', async () => {
  const connect = vi.fn();
  const tools = await connectCodexMcpTools(
    { docs: { execution: 'sandbox', command: '/usr/bin/docs-mcp' } },
    {
      cwd: '/workspace',
      env: {},
      signal: new AbortController().signal,
      connect,
    },
  );
  expect(connect).not.toHaveBeenCalled();
  expect(tools.definitions).toEqual([]);
  await tools.close();
});

it('discovers all configured tools and routes calls through canonical Mitzo permissions before effects', async () => {
  const call = vi.fn(async () => ({ content: [{ type: 'text', text: 'result' }] }));
  const close = vi.fn(async () => {});
  const permission = vi.fn(async () => ({
    behavior: 'allow' as const,
    updatedInput: { query: 'approved' },
  }));
  const tools = await connectCodexMcpTools(
    { work: { command: 'mcp' } },
    {
      cwd: '/workspace',
      env: { PATH: '/bin' },
      signal: new AbortController().signal,
      connect: async () => ({
        listTools: async () => ({
          tools: [{ name: 'search', description: 'Search', inputSchema: { type: 'object' } }],
        }),
        callTool: call,
        close,
      }),
    },
  );
  expect(tools.definitions).toHaveLength(1);
  const wire = tools.definitions[0].name;
  expect(tools.displayName(wire)).toBe('mcp__work__search');
  expect(tools.displayName('Read')).toBe('Read');
  expect(wire).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  expect(
    await tools.execute(wire, { query: 'original' }, permission, new AbortController().signal),
  ).toEqual({ content: 'result', isError: false });
  expect(permission).toHaveBeenCalledWith(
    'mcp__work__search',
    { query: 'original' },
    expect.anything(),
  );
  expect(call).toHaveBeenCalledWith(
    { name: 'search', arguments: { query: 'approved' } },
    expect.anything(),
  );
  await tools.close();
  expect(close).toHaveBeenCalledOnce();
});
it('keeps long canonical tool names within the 64-character wire limit', async () => {
  const server = 'server_name_that_is_far_longer_than_the_readable_prefix';
  const tool = 'tool_name_that_is_also_far_longer_than_the_readable_prefix';
  const canonical = `mcp__${server}__${tool}`;
  const close = vi.fn(async () => {});
  const tools = await connectCodexMcpTools(
    { [server]: { command: 'mcp' } },
    {
      cwd: '/workspace',
      env: {},
      signal: new AbortController().signal,
      connect: async () => ({
        listTools: async () => ({ tools: [{ name: tool, inputSchema: { type: 'object' } }] }),
        callTool: vi.fn(),
        close,
      }),
    },
  );

  const wire = tools.definitions[0].name;
  expect(wire).toHaveLength(42);
  expect(wire).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  expect(tools.displayName(wire)).toBe(canonical);
  await tools.close();
});
it('denies unknown or disallowed calls and closes connected peers on discovery failure', async () => {
  const call = vi.fn();
  const close = vi.fn(async () => {});
  const tools = await connectCodexMcpTools(
    { work: { command: 'mcp' } },
    {
      cwd: '/workspace',
      env: {},
      signal: new AbortController().signal,
      connect: async () => ({
        listTools: async () => ({ tools: [{ name: 'write', inputSchema: { type: 'object' } }] }),
        callTool: call,
        close,
      }),
    },
  );
  expect(
    (
      await tools.execute(
        tools.definitions[0].name,
        {},
        async () => ({ behavior: 'deny' as const }),
        new AbortController().signal,
      )
    ).isError,
  ).toBe(true);
  await expect(
    tools.execute(
      'unknown',
      {},
      async () => ({ behavior: 'allow' as const, updatedInput: {} }),
      new AbortController().signal,
    ),
  ).rejects.toThrow('Unknown');
  expect(call).not.toHaveBeenCalled();
  await tools.close();
  const failedClose = vi.fn(async () => {});
  await expect(
    connectCodexMcpTools(
      { broken: { command: 'mcp' } },
      {
        cwd: '/workspace',
        env: {},
        signal: new AbortController().signal,
        connect: async () => ({
          listTools: async () => {
            throw new Error('private-secret');
          },
          callTool: call,
          close: failedClose,
        }),
      },
    ),
  ).rejects.toThrow('MCP initialization failed');
  expect(failedClose).toHaveBeenCalledOnce();
});
