import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
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
  process.argv = [
    'node',
    'telos',
    '--base-url',
    'http://host',
    '--client-id',
    'client',
    '--session-id',
    'source-chat',
  ];
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
      'TelosCreateSession',
    ]),
  );
  const createSchema = z.object(
    registered.get('TelosCreateSession')!.definition.inputSchema as z.ZodRawShape,
  );
  expect(createSchema.safeParse({ requestId: 'invalid' }).success).toBe(false);
  const createInput = {
    requestId: '8fea0d55-cded-43a0-8ab1-34e95ca9456e',
    itemId: 'selected-slice',
    expectedRevision: 'a'.repeat(64),
    title: 'Slice',
    prompt: 'Reviewed work',
  };
  const createFetch = vi
    .fn()
    .mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'This child runtime is unsupported; select Local Mac Codex.' }),
        { status: 409 },
      ),
    );
  vi.stubGlobal('fetch', createFetch);
  expect(await registered.get('TelosCreateSession')!.run(createInput)).toMatchObject({
    isError: true,
  });
  expect(createFetch).toHaveBeenCalledWith(
    'http://host/api/internal/telos/session/propose',
    expect.objectContaining({
      body: JSON.stringify({
        clientId: 'client',
        sessionId: 'source-chat',
        input: createSchema.parse(createInput),
      }),
    }),
  );
  const legacy = {
    summary: 'Retained outcome',
    intent: 'Preserve reviewed work',
    rationale: 'Recover without reinterpretation',
    acceptanceCriteria: ['Receipt survives'],
    milestones: ['One original slice'],
    profile: 'manual',
    __mitzoTelosApproval: '00000000-0000-4000-8000-000000000001',
  };
  const schema = z.object(
    registered.get('TelosCreateOutcome')!.definition.inputSchema as z.ZodRawShape,
  );
  expect(schema.parse(legacy)).toEqual(legacy);
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
