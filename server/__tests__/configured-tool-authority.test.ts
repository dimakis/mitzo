import { expect, it, vi } from 'vitest';
import { ConfiguredToolCatalog } from '../configured-tool-catalog.js';
import { admitConfiguredTools } from '../configured-tool-admission.js';
function fixture() {
  const catalog = new ConfiguredToolCatalog(':memory:');
  const sources = {
    a__b: { command: 'first', librarySourceId: '11111111-1111-4111-8111-111111111111' },
    a: { command: 'second', librarySourceId: '22222222-2222-4222-8222-222222222222' },
  };
  const call = vi.fn(async (params: { name: string; arguments: Record<string, unknown> }) => ({
    content: [{ type: 'text', text: params.name }],
  }));
  const close = vi.fn(async () => {});
  const abort = new AbortController();
  const connect = vi.fn(async (config: { command: string }) => ({
    listTools: async () => ({
      tools: [
        {
          name: config.command === 'first' ? 'c' : 'b__c',
          inputSchema: { type: 'object' },
          annotations: { readOnlyHint: true, destructiveHint: false },
        },
      ],
    }),
    callTool: call,
    close,
  }));
  const options = {
    cwd: '/fixture',
    env: {},
    signal: abort.signal,
    readSources: () => sources,
    assertRuntimeCurrent: vi.fn(),
    connect,
  };
  return { catalog, sources, call, close, abort, connect, options };
}
it('keeps delimiter collisions distinct and permissions source-scoped despite untrusted hints', async () => {
  const f = fixture();
  try {
    const entries = await f.catalog.refresh(f.options);
    expect(entries.map((entry) => entry.behavior)).toEqual(['mixed', 'mixed']);
    const admitted = await admitConfiguredTools(
      f.catalog,
      entries.map((entry) => f.catalog.reference(entry)),
      f.options,
    );
    try {
      expect(new Set(admitted.definitions.map((entry) => entry.name)).size).toBe(2);
      const permission = vi.fn(async (name: string) => {
        void name;
        return { behavior: 'allow' as const };
      });
      for (const tool of admitted.definitions)
        await admitted.execute(tool.name, {}, permission, f.abort.signal);
      expect(permission.mock.calls.map((call) => call[0])).toEqual([
        `configured-mcp:${JSON.stringify(['11111111-1111-4111-8111-111111111111', 'c'])}`,
        `configured-mcp:${JSON.stringify(['22222222-2222-4222-8222-222222222222', 'b__c'])}`,
      ]);
      expect(f.call.mock.calls.map((call) => call[0].name)).toEqual(['c', 'b__c']);
    } finally {
      await admitted.close();
    }
  } finally {
    f.catalog.close();
  }
});
it.each(['revocation', 'cancellation'] as const)(
  'blocks %s during awaited approval before peer effects',
  async (reason) => {
    const f = fixture();
    try {
      const entry = (await f.catalog.refresh(f.options))[0];
      const admitted = await admitConfiguredTools(
        f.catalog,
        [f.catalog.reference(entry)],
        f.options,
      );
      try {
        let release!: () => void;
        const waiting = new Promise<void>((resolve) => {
          release = resolve;
        });
        const permission = vi.fn(async () => {
          await waiting;
          return { behavior: 'allow' as const };
        });
        const pending = admitted.execute(
          admitted.definitions[0].name,
          {},
          permission,
          new AbortController().signal,
        );
        await vi.waitFor(() => expect(permission).toHaveBeenCalledOnce());
        // Revoke the selected source rather than the similarly named other source.
        if (reason === 'revocation') f.sources['a__b'].command = 'revoked';
        else f.abort.abort();
        release();
        await expect(pending).rejects.toThrow();
        expect(f.call).not.toHaveBeenCalled();
      } finally {
        await admitted.close();
      }
    } finally {
      f.catalog.close();
    }
  },
);
it('rejects a changed discovered schema before exposure even without a library refresh', async () => {
  const f = fixture();
  try {
    const entry = (await f.catalog.refresh(f.options))[0];
    await expect(
      admitConfiguredTools(f.catalog, [f.catalog.reference(entry)], {
        ...f.options,
        connect: async () => ({
          listTools: async () => ({
            tools: [{ name: 'c', inputSchema: { type: 'object', required: ['different'] } }],
          }),
          callTool: f.call,
          close: f.close,
        }),
      }),
    ).rejects.toThrow(/definition changed/);
    expect(f.call).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledTimes(3);
  } finally {
    f.catalog.close();
  }
});
