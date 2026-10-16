import { expect, it, vi } from 'vitest';
import { ConfiguredToolCatalog } from '../configured-tool-catalog.js';
import { admitConfiguredTools } from '../configured-tool-admission.js';
import type { McpToolsOptions } from '../codex-mcp-tools.js';

it('launches an admitted source in its discovery directory rather than the chat worktree', async () => {
  const catalog = new ConfiguredToolCatalog(':memory:');
  const configs = {
    docs: {
      command: 'fake',
      args: ['relative-server.js'],
      librarySourceId: '11111111-1111-4111-8111-111111111111',
    },
  };
  const connect = vi.fn(async (_config: unknown, options: McpToolsOptions) => ({
    listTools: async () => ({
      tools: [
        {
          name: 'search',
          inputSchema: { type: 'object', description: options.cwd ? 'fixture' : 'invalid' },
        },
      ],
    }),
    callTool: vi.fn(),
    close: vi.fn(async () => {}),
  }));
  const options = {
    cwd: '/authorized-source',
    env: {},
    signal: new AbortController().signal,
    readSources: () => configs,
    assertRuntimeCurrent: vi.fn(),
    connect,
  };
  try {
    const ref = catalog.reference((await catalog.refresh(options))[0]);
    connect.mockClear();
    const tools = await admitConfiguredTools(catalog, [ref], {
      ...options,
      cwd: '/different-task-worktree',
    });
    try {
      expect(connect.mock.calls[0][1].cwd).toBe('/authorized-source');
    } finally {
      await tools.close();
    }
  } finally {
    catalog.close();
  }
});
