import { expect, it, vi } from 'vitest';
import { connectCodexMcpTools } from '../codex-mcp-tools.js';
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
