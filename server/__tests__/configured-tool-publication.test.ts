import { expect, it, vi } from 'vitest';
import { AgentLibraryStore } from '../agent-library-store.js';
import { ConfiguredToolCatalog } from '../configured-tool-catalog.js';

it('keeps a profile published during refresh immutable and refuses its superseded tool receipt', async () => {
  const catalog = new ConfiguredToolCatalog(':memory:');
  const library = new AgentLibraryStore(':memory:');
  const list = vi.fn(async () => ({
    tools: [{ name: 'search', inputSchema: { type: 'object' } }],
  }));
  const options = {
    cwd: '/fixture',
    env: {},
    signal: new AbortController().signal,
    assertRuntimeCurrent: vi.fn(),
    readSources: () => ({
      docs: { command: 'fake', librarySourceId: '11111111-1111-4111-8111-111111111111' },
    }),
    connect: async () => ({ listTools: list, callTool: vi.fn(), close: vi.fn(async () => {}) }),
  };
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let refresh: ReturnType<ConfiguredToolCatalog['refresh']> | undefined;
  try {
    const ref = catalog.reference((await catalog.refresh(options))[0]);
    list.mockImplementation(async () => {
      await waiting;
      return { tools: [{ name: 'search', inputSchema: { type: 'string' } }] };
    });
    refresh = catalog.refresh(options);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    const draft = library.saveDraft('user', {
      profileId: 'during-refresh',
      expectedVersion: 0,
      expectedRevision: 0,
      idempotencyKey: 'save',
      definition: {
        name: 'Pinned',
        role: 'agent',
        instructions: 'Help',
        expectedOutput: 'Result',
        acceptanceCriteria: ['Correct'],
        modelPolicyRole: 'agent',
        tools: [ref],
      },
    });
    const published = library.publish('user', {
      profileId: draft.profileId,
      expectedVersion: draft.version,
      idempotencyKey: 'publish',
    });
    const serialized = JSON.stringify(published);
    release();
    await refresh;
    expect(JSON.stringify(library.version('user', published.profileId, published.revision))).toBe(
      serialized,
    );
    expect(published.definition.tools).toEqual([ref]);
    expect(() => catalog.resolve(ref, options)).toThrow(/unavailable|changed/);
    expect(catalog.list()[0].version).toBeGreaterThan(ref.version);
  } finally {
    release();
    await refresh;
    library.close();
    catalog.close();
  }
});
