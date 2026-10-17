import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentToolReferencesSchema } from '../../packages/protocol/src/agent-tools.js';
import { ConfiguredToolCatalog } from '../configured-tool-catalog.js';
import { DEFAULT_INHERITED_ENV_VARS } from '@modelcontextprotocol/sdk/client/stdio.js';

const left = '11111111-1111-4111-8111-111111111111';
const right = '22222222-2222-4222-8222-222222222222';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'configured-tools-'));
  roots.push(directory);
  const path = join(directory, 'catalog.db');
  const sources = {
    left: { command: 'fake-left', librarySourceId: left },
    right: { command: 'fake-right', librarySourceId: right },
  };
  let tools = [
    { name: 'search', description: 'Untrusted search', inputSchema: { type: 'object' } },
  ];
  const close = vi.fn(async () => {});
  const call = vi.fn(async () => ({ content: [] }));
  const connect = vi.fn(async () => ({
    listTools: async () => ({ tools }),
    close,
    callTool: call,
  }));
  const options = {
    cwd: '/fixture',
    env: {},
    signal: new AbortController().signal,
    assertRuntimeCurrent: vi.fn(),
    connect,
    readSources: () => sources,
  };
  return {
    path,
    sources,
    options,
    connect,
    close,
    call,
    setTools: (value: typeof tools) => {
      tools = value;
    },
  };
}
it('discovers duplicate names as distinct portable contracts and closes every fake peer', async () => {
  const f = fixture();
  const catalog = new ConfiguredToolCatalog(f.path);
  try {
    const rows = await catalog.refresh(f.options);
    expect(rows).toHaveLength(2);
    expect(rows[0].routes).toEqual(['local-api', 'codex', 'codex-owned-local']);
    expect(rows[0].id).not.toBe(rows[1].id);
    expect(rows.map((r) => r.name)).toEqual(['search', 'search']);
    for (const row of rows)
      expect(AgentToolReferencesSchema.parse([catalog.reference(row)])).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toMatch(/fake-left|fake-right/);
    expect(f.close).toHaveBeenCalledTimes(2);
    expect(f.call).not.toHaveBeenCalled();
  } finally {
    catalog.close();
  }
});
it('retains exact versions across reopen, additions, removal, schema drift and restoration', async () => {
  const f = fixture();
  let catalog = new ConfiguredToolCatalog(f.path);
  const original = (await catalog.refresh(f.options))[0];
  const ref = catalog.reference(original);
  catalog.close();
  catalog = new ConfiguredToolCatalog(f.path);
  try {
    expect(catalog.resolve(ref, f.options).name).toBe('search');
    expect((await catalog.refresh(f.options))[0]).toEqual(original);
    f.setTools([{ name: 'new', description: 'new', inputSchema: { type: 'object' } }]);
    await catalog.refresh(f.options);
    expect(() => catalog.resolve(ref, f.options)).toThrow(/unavailable|removed/i);
    f.setTools([
      { name: 'search', description: 'Untrusted search', inputSchema: { type: 'object' } },
    ]);
    const restored = (await catalog.refresh(f.options))[0];
    expect(restored.version).toBeGreaterThan(original.version);
    expect(restored.revision).not.toBe(original.revision);
    expect(() => catalog.resolve(ref, f.options)).toThrow(/changed|unavailable/i);
    f.setTools([
      { name: 'search', description: 'Untrusted search', inputSchema: { type: 'string' } },
    ]);
    expect((await catalog.refresh(f.options))[0].version).toBeGreaterThan(restored.version);
    expect(ref).toEqual(catalog.reference(original));
  } finally {
    catalog.close();
  }
});
it('refuses foreign receipts, source replacement, disablement and configuration drift without name matching', async () => {
  const f = fixture();
  const catalog = new ConfiguredToolCatalog(f.path);
  const foreign = new ConfiguredToolCatalog(':memory:');
  try {
    const row = (await catalog.refresh(f.options))[0];
    const ref = catalog.reference(row);
    expect(() => foreign.resolve(ref, f.options)).toThrow(/unresolved/i);
    f.sources.left.command = 'replacement';
    expect(() => catalog.resolve(ref, f.options)).toThrow(/configuration|changed/i);
    delete (f.sources as Partial<typeof f.sources>).left;
    expect(() => catalog.resolve(ref, f.options)).toThrow(/unavailable|configured/i);
  } finally {
    catalog.close();
    foreign.close();
  }
});
it('rejects absent custody and duplicate source identities before creating processes', async () => {
  const f = fixture();
  const catalog = new ConfiguredToolCatalog(f.path);
  try {
    await expect(
      catalog.refresh({ ...f.options, assertRuntimeCurrent: undefined } as never),
    ).rejects.toThrow(/authority|custody/i);
    f.sources.right.librarySourceId = left;
    await expect(catalog.refresh(f.options)).rejects.toThrow(/duplicate/i);
    expect(f.connect).not.toHaveBeenCalled();
  } finally {
    catalog.close();
  }
});
it('rejects late stale results and preserves the saved catalog after cancellation or failure', async () => {
  const f = fixture();
  const catalog = new ConfiguredToolCatalog(f.path);
  try {
    const original = await catalog.refresh(f.options);
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const stale = catalog.refresh({
      ...f.options,
      connect: async () => ({
        listTools: async () => {
          await pending;
          return { tools: [] };
        },
        close: f.close,
        callTool: f.call,
      }),
    });
    await vi.waitFor(() => expect(f.close).toHaveBeenCalledTimes(2));
    await catalog.refresh(f.options);
    finish();
    await expect(stale).rejects.toThrow(/superseded|cancelled/i);
    expect(catalog.list()).toEqual(original);
    const abort = new AbortController();
    abort.abort();
    await expect(catalog.refresh({ ...f.options, signal: abort.signal })).rejects.toThrow();
    expect(catalog.list()).toEqual(original);
  } finally {
    catalog.close();
  }
});
it('never launches unregistered or sandbox-only sources, rejects config changes before publication', async () => {
  const f = fixture();
  const catalog = new ConfiguredToolCatalog(f.path);
  try {
    await catalog.refresh({
      ...f.options,
      readSources: () => ({
        legacy: { command: 'never' },
        isolated: { ...f.sources.left, execution: 'sandbox' },
      }),
    });
    expect(f.connect).not.toHaveBeenCalled();
    await expect(
      catalog.refresh({
        ...f.options,
        connect: async () => ({
          listTools: async () => {
            f.sources.left.command = 'changed';
            return { tools: [] };
          },
          close: f.close,
          callTool: f.call,
        }),
      }),
    ).rejects.toThrow();
    expect(catalog.list()).toEqual([]);
    expect(f.close).toHaveBeenCalledOnce();
  } finally {
    catalog.close();
  }
});
it('binds trusted source configuration independently of each authorized runtime workspace', async () => {
  const f = fixture();
  const catalog = new ConfiguredToolCatalog(f.path);
  try {
    const ref = catalog.reference((await catalog.refresh(f.options))[0]);
    expect(
      catalog.resolve(ref, {
        ...f.options,
        cwd: '/another-authorized-worktree',
        env: f.options.env,
      }).tool,
    ).toBe('search');
    f.sources.left.command = 'replaced';
    expect(() => catalog.resolve(ref, f.options)).toThrow(/configuration changed/);
  } finally {
    catalog.close();
  }
});
it('bounds configured source count before starting any peer', async () => {
  const f = fixture();
  const catalog = new ConfiguredToolCatalog(f.path);
  try {
    const sources = Object.fromEntries(
      Array.from({ length: 65 }, (_, i) => [
        `source-${i}`,
        {
          command: 'fake',
          librarySourceId: `${i.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`,
        },
      ]),
    );
    await expect(catalog.refresh({ ...f.options, readSources: () => sources })).rejects.toThrow(
      /too many|limit/i,
    );
    expect(f.connect).not.toHaveBeenCalled();
  } finally {
    catalog.close();
  }
});
it('retains the private source launch directory and rejects ambient launch-environment drift', async () => {
  const f = fixture();
  const catalog = new ConfiguredToolCatalog(f.path);
  try {
    const ref = catalog.reference((await catalog.refresh(f.options))[0]);
    expect(catalog.resolve(ref, { ...f.options, cwd: '/task-worktree' }).launchCwd).toBe(
      '/fixture',
    );
    expect(() => catalog.resolve(ref, { ...f.options, env: { PATH: '/replacement-bin' } })).toThrow(
      /configuration|environment/,
    );
    expect(JSON.stringify(catalog.list())).not.toContain('/fixture');
  } finally {
    catalog.close();
  }
});
it.each(['PATH', DEFAULT_INHERITED_ENV_VARS.includes('HOME') ? 'HOME' : 'USERPROFILE'])(
  'refuses inherited %s drift even when the supplied environment is unchanged',
  async (key) => {
    const f = fixture();
    const catalog = new ConfiguredToolCatalog(f.path);
    const previous = process.env[key];
    try {
      process.env[key] = '/ambient-original';
      const ref = catalog.reference((await catalog.refresh(f.options))[0]);
      process.env[key] = '/ambient-replacement';
      expect(() => catalog.resolve(ref, f.options)).toThrow(/configuration|environment/);
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
      catalog.close();
    }
  },
);
it.each(['caller', 'source'])(
  'retains a receipt when %s PATH explicitly overrides the changed ambient PATH',
  async (origin) => {
    const f = fixture();
    const catalog = new ConfiguredToolCatalog(f.path);
    const previous = process.env.PATH;
    const options = { ...f.options, env: origin === 'caller' ? { PATH: '/explicit' } : {} };
    if (origin === 'source') Object.assign(f.sources.left, { env: { PATH: '/explicit' } });
    try {
      process.env.PATH = '/ambient-original';
      const ref = catalog.reference((await catalog.refresh(options))[0]);
      process.env.PATH = '/ambient-replacement';
      expect(catalog.resolve(ref, options).sourceId).toBe(left);
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
      catalog.close();
    }
  },
);
it('rejects inherited environment drift during discovery before publishing and awaits cleanup', async () => {
  const f = fixture();
  const catalog = new ConfiguredToolCatalog(f.path);
  const previous = process.env.PATH;
  const close = vi.fn(async () => {});
  try {
    process.env.PATH = '/ambient-original';
    const saved = await catalog.refresh(f.options);
    await expect(
      catalog.refresh({
        ...f.options,
        connect: async () => ({
          listTools: async () => {
            process.env.PATH = '/ambient-replacement';
            return { tools: [{ name: 'unbound', inputSchema: { type: 'object' } }] };
          },
          callTool: vi.fn(),
          close,
        }),
      }),
    ).rejects.toThrow('MCP initialization failed');
    expect(catalog.list()).toEqual(saved);
    expect(close).toHaveBeenCalledOnce();
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
    catalog.close();
  }
});
it('versions the full discovered descriptor including output schema and annotation changes', async () => {
  const f = fixture();
  const catalog = new ConfiguredToolCatalog(f.path);
  let outputSchema = { type: 'object' };
  const options = {
    ...f.options,
    connect: async () => ({
      listTools: async () => ({
        tools: [
          {
            name: 'search',
            inputSchema: { type: 'object' },
            outputSchema,
            annotations: { readOnlyHint: true },
          },
        ],
      }),
      callTool: f.call,
      close: f.close,
    }),
  };
  try {
    const original = (await catalog.refresh(options))[0];
    outputSchema = { type: 'string' };
    const changed = (await catalog.refresh(options))[0];
    expect(changed.version).toBeGreaterThan(original.version);
    expect(() => catalog.resolve(catalog.reference(original), options)).toThrow(
      /changed|unavailable/,
    );
  } finally {
    catalog.close();
  }
});
it('discovers delimiter-colliding server/tool labels using structured source identities', async () => {
  const f = fixture();
  const catalog = new ConfiguredToolCatalog(f.path);
  try {
    const entries = await catalog.refresh({
      ...f.options,
      readSources: () => ({ work__docs: f.sources.left, work: f.sources.right }),
      connect: async (config) => ({
        listTools: async () => ({
          tools: [
            {
              name: config.librarySourceId === left ? 'search' : 'docs__search',
              inputSchema: { type: 'object' },
            },
          ],
        }),
        callTool: f.call,
        close: f.close,
      }),
    });
    expect(entries).toHaveLength(2);
    expect(entries[0].id).not.toBe(entries[1].id);
    expect(f.call).not.toHaveBeenCalled();
  } finally {
    catalog.close();
  }
});
it('refuses inherited per-source discovery directory overrides before launching a peer', async () => {
  const f = fixture();
  const catalog = new ConfiguredToolCatalog(f.path);
  try {
    await expect(
      catalog.refresh({ ...f.options, cwdForSource: () => '/unrecorded' } as never),
    ).rejects.toThrow(/directory override/i);
    expect(f.connect).not.toHaveBeenCalled();
  } finally {
    catalog.close();
  }
});
it('keeps cancelled refresh unsettled until the real peer shutdown has finished', async () => {
  const f = fixture();
  const catalog = new ConfiguredToolCatalog(f.path);
  const abort = new AbortController();
  let finishList!: () => void;
  let finishClose!: () => void;
  const listing = new Promise<void>((resolve) => {
    finishList = resolve;
  });
  const shutdown = new Promise<void>((resolve) => {
    finishClose = resolve;
  });
  const listTools = vi.fn(async () => {
    await listing;
    return { tools: [] };
  });
  const close = vi.fn(async () => {
    await shutdown;
  });
  let settled = false;
  const pending = catalog
    .refresh({
      ...f.options,
      signal: abort.signal,
      connect: async () => ({ listTools, callTool: f.call, close }),
    })
    .then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
  try {
    await vi.waitFor(() => expect(listTools).toHaveBeenCalledOnce());
    abort.abort();
    finishList();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    finishClose();
    expect(await pending).toBeInstanceOf(Error);
    expect(catalog.list()).toEqual([]);
  } finally {
    finishList();
    finishClose();
    await pending;
    catalog.close();
  }
});
it('pins an absolute source directory when the configured discovery workspace is relative', async () => {
  const f = fixture();
  const catalog = new ConfiguredToolCatalog(f.path);
  let launched: string | undefined;
  const options = {
    ...f.options,
    cwd: '.',
    readSources: () => ({ docs: f.sources.left }),
    connect: async (
      _config: unknown,
      peerOptions: import('../codex-mcp-tools.js').McpToolsOptions,
    ) => {
      launched = peerOptions.cwd;
      return {
        listTools: async () => ({ tools: [{ name: 'search', inputSchema: { type: 'object' } }] }),
        callTool: f.call,
        close: f.close,
      };
    },
  };
  try {
    const ref = catalog.reference((await catalog.refresh(options))[0]);
    expect(launched).toBe(process.cwd());
    expect(catalog.resolve(ref, { ...options, cwd: '/another-task' }).launchCwd).toBe(
      process.cwd(),
    );
  } finally {
    catalog.close();
  }
});
it('refuses malformed Unicode names before UTF-8 fingerprinting can collapse distinct names', async () => {
  const f = fixture();
  const catalog = new ConfiguredToolCatalog(f.path);
  f.setTools(
    ['\ud800', '\ud801'].map((name) => ({
      name,
      description: 'Invalid name',
      inputSchema: { type: 'object' },
    })),
  );
  try {
    await expect(catalog.refresh(f.options)).rejects.toThrow(/unicode/i);
    expect(catalog.list()).toEqual([]);
  } finally {
    catalog.close();
  }
});
