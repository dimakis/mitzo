import { afterEach, expect, it, vi } from 'vitest';
const registered = vi.hoisted(
  () =>
    new Map<
      string,
      {
        definition: { inputSchema: unknown };
        run(
          input: Record<string, unknown>,
        ): Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
      }
    >(),
);
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    registerTool(name: string, definition: { inputSchema: unknown }, run: never) {
      registered.set(name, { definition, run });
    }
    async connect() {}
  },
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: class {} }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it('offers the same read/update schemas through MCP and uses host-authenticated updates', async () => {
  const previous = process.argv;
  process.argv = ['node', 'telos', '--base-url', 'http://host', '--client-id', 'client'];
  vi.stubEnv('MITZO_INTERNAL_TOKEN', 'synthetic-token');
  try {
    await import('../telos-mcp-server.js');
  } finally {
    process.argv = previous;
  }
  expect([...registered.keys()]).toEqual(
    expect.arrayContaining([
      'TelosCreateOutcome',
      'TelosGetItem',
      'TelosUpdateItem',
      'TelosSaveArtifact',
    ]),
  );
  expect(Object.keys(registered.get('TelosGetItem')!.definition.inputSchema as object)).toEqual([
    'itemId',
  ]);
  expect(
    Object.keys(registered.get('TelosUpdateItem')!.definition.inputSchema as object),
  ).toContain('expectedRevision');
  const input = {
    itemId: 'task',
    requestId: 'finish',
    expectedRevision: 'a'.repeat(64),
    status: 'completed',
    note: 'Report saved and criteria met.',
  };
  const receipt = {
    ok: true,
    item: { id: 'task', status: 'completed', revision: 'b'.repeat(64) },
    update: { sessionId: 'host-session', note: input.note },
  };
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(receipt)));
  vi.stubGlobal('fetch', fetch);
  expect(await registered.get('TelosUpdateItem')!.run(input)).toEqual({
    content: [{ type: 'text', text: JSON.stringify(receipt) }],
  });
  expect(fetch).toHaveBeenCalledWith(
    'http://host/api/internal/telos/items/update',
    expect.objectContaining({
      headers: expect.objectContaining({
        'X-Internal-Token': 'synthetic-token',
        'X-Client-Id': 'client',
      }),
    }),
  );
});
