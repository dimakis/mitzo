import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeHooks } from '../native-hooks.js';
import * as commands from '../protected-sdk-command.js';
import { expect, it, vi } from 'vitest';
import { connectCodexMcpTools } from '../codex-mcp-tools.js';
import { SessionRegistry, buildPermissionHandler, resolvePending } from '@mitzo/harness';

it('refuses stale MCP startup before any peer launch', async () => {
  const connect = vi.fn();
  await expect(
    connectCodexMcpTools(
      { work: { command: 'fixture' } },
      {
        cwd: '/workspace',
        env: {},
        signal: new AbortController().signal,
        connect,
        assertRuntimeCurrent: () => {
          throw Error('stale runtime');
        },
      },
    ),
  ).rejects.toThrow('MCP initialization failed');
  expect(connect).not.toHaveBeenCalled();
});

it.each(['connection', 'discovery', 'abort'] as const)(
  'rechecks owned MCP startup after awaited %s and refuses the next launch/page',
  async (phase) => {
    let revoked = false;
    const abort = new AbortController();
    const close = vi.fn(async () => {});
    const listTools = vi.fn(async () => {
      if (phase === 'discovery') revoked = true;
      if (phase === 'abort') abort.abort();
      return {
        tools: [{ name: 'read', inputSchema: { type: 'object' } }],
        nextCursor: 'next-page',
      };
    });
    const connect = vi.fn(async () => {
      if (phase === 'connection') revoked = true;
      return { listTools, callTool: vi.fn(), close };
    });
    await expect(
      connectCodexMcpTools(
        { first: { command: 'first' }, second: { command: 'second' } },
        {
          cwd: '/workspace',
          env: {},
          signal: abort.signal,
          connect,
          assertRuntimeCurrent: () => {
            if (revoked) throw Error('stale runtime');
          },
        },
      ),
    ).rejects.toThrow('MCP initialization failed');
    expect(connect).toHaveBeenCalledOnce();
    expect(listTools).toHaveBeenCalledTimes(phase === 'connection' ? 0 : 1);
    expect(close).toHaveBeenCalledOnce();
  },
);

it('rechecks owning runtime after awaited MCP approval and before native call', async () => {
  let revoked = false;
  const call = vi.fn(async () => ({ content: [] }));
  const tools = await connectCodexMcpTools(
    { work: { command: 'fixture-mcp' } },
    {
      cwd: '/workspace',
      env: {},
      signal: new AbortController().signal,
      assertRuntimeCurrent: () => {
        if (revoked) throw new Error('Owned runtime unavailable');
      },
      connect: async () => ({
        listTools: async () => ({ tools: [{ name: 'write', inputSchema: { type: 'object' } }] }),
        callTool: call,
        close: vi.fn(async () => {}),
      }),
    },
  );
  try {
    await expect(
      tools.execute(
        tools.definitions[0].name,
        {},
        async () => {
          revoked = true;
          return { behavior: 'allow' as const, updatedInput: {} };
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('Owned runtime unavailable');
    expect(call).not.toHaveBeenCalled();
  } finally {
    await tools.close();
  }
});

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

it('preserves the actual approval failure reason instead of claiming the user declined', async () => {
  const call = vi.fn();
  const tools = await connectCodexMcpTools(
    { work: { command: 'mcp' } },
    {
      cwd: '/workspace',
      env: {},
      signal: new AbortController().signal,
      connect: async () => ({
        listTools: async () => ({ tools: [{ name: 'search', inputSchema: { type: 'object' } }] }),
        callTool: call,
        close: async () => {},
      }),
    },
  );
  try {
    for (const message of [
      'Tool approval expired without a response; request approval again',
      'Session taken over by another device',
      'User denied',
    ]) {
      expect(
        await tools.execute(
          tools.definitions[0].name,
          {},
          async () => ({ behavior: 'deny', message }),
          new AbortController().signal,
        ),
      ).toEqual({ content: message, isError: true });
    }
    expect(call).not.toHaveBeenCalled();
  } finally {
    await tools.close();
  }
});

it('runs Work API Google and Telos tools after real once/session approvals and retains mode ceilings', async () => {
  const registry = new SessionRegistry();
  const requests: Record<string, unknown>[] = [];
  registry.register('work-api', {
    sessionId: 'work-conversation',
    transport: {
      send: (event) => {
        if (event.type === 'permission_request') requests.push(event);
      },
      isOpen: () => true,
    },
    abortController: new AbortController(),
    mode: 'agent',
    sessionAllowList: new Set(),
  });
  const call = vi.fn(async () => ({ content: [{ type: 'text', text: 'completed' }] }));
  const tools = await connectCodexMcpTools(
    { gws: { command: 'synthetic-google' }, telos: { command: 'synthetic-telos' } },
    {
      cwd: '/workspace',
      env: {},
      signal: new AbortController().signal,
      connect: async (config) => ({
        listTools: async () => ({
          tools: [config.command === 'synthetic-google' ? 'google_search' : 'telos_save'].map(
            (name) => ({
              name,
              inputSchema: { type: 'object' },
            }),
          ),
        }),
        callTool: call,
        close: async () => {},
      }),
    },
  );
  const permission = (name: string, input: Record<string, unknown>, signal: AbortSignal) =>
    buildPermissionHandler('work-api', registry)(name, input, { signal, toolUseID: name });
  const abort = new AbortController();
  try {
    const google = tools.definitions.find((tool) =>
      tools.displayName(tool.name).endsWith('__google_search'),
    )!.name;
    const telos = tools.definitions.find((tool) =>
      tools.displayName(tool.name).endsWith('__telos_save'),
    )!.name;
    for (const [wire, decision] of [
      [google, 'once'],
      [google, 'always'],
      [telos, 'always'],
    ] as const) {
      const before = requests.length;
      const execution = tools.execute(wire, { query: 'approved input' }, permission, abort.signal);
      await vi.waitFor(() => expect(requests).toHaveLength(before + 1));
      expect(
        resolvePending(requests.at(-1)!.permId as string, decision, undefined, 'work-conversation'),
      ).toBe(true);
      expect(await execution).toEqual({ content: 'completed', isError: false });
    }
    expect(requests).toHaveLength(3);
    for (const wire of [google, telos])
      expect(await tools.execute(wire, { query: 'next input' }, permission, abort.signal)).toEqual({
        content: 'completed',
        isError: false,
      });
    expect(requests).toHaveLength(3);
    expect(call).toHaveBeenCalledTimes(5);
    registry.setMode('work-api', 'ask');
    const blocked = await tools.execute(telos, { query: 'blocked' }, permission, abort.signal);
    expect(blocked.isError).toBe(true);
    expect(call).toHaveBeenCalledTimes(5);
  } finally {
    abort.abort();
    await tools.close();
    registry.dispose();
  }
});
it('bounds empty unique-cursor pagination and closes the peer', async () => {
  const close = vi.fn(async () => {});
  let page = 0;
  await expect(
    connectCodexMcpTools(
      { fixture: { command: 'never-started' } },
      {
        cwd: '/fixture',
        env: {},
        signal: new AbortController().signal,
        connect: async () => ({
          listTools: async () => ({ tools: [], nextCursor: `page-${++page}` }),
          callTool: vi.fn(),
          close,
        }),
      },
    ),
  ).rejects.toThrow('MCP initialization failed');
  expect(page).toBe(100);
  expect(close).toHaveBeenCalledOnce();
});

it('keeps permissions source-scoped when opted-in labels collide after delimiter concatenation', async () => {
  const sourceIds = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ];
  const permission = vi.fn(async (_name: string) => ({ behavior: 'allow' as const }));
  const callTool = vi.fn(async () => ({ content: [] }));
  const signal = new AbortController().signal;
  const tools = await connectCodexMcpTools(
    {
      work__docs: { command: 'first', librarySourceId: sourceIds[0] },
      work: { command: 'second', librarySourceId: sourceIds[1] },
    },
    {
      cwd: '/fixture',
      env: {},
      signal,
      connect: async (config) => ({
        listTools: async () => ({
          tools: [
            {
              name: config.command === 'first' ? 'search' : 'docs__search',
              inputSchema: { type: 'object' },
            },
          ],
        }),
        callTool,
        close: async () => {},
      }),
    },
  );
  try {
    for (const tool of tools.definitions) await tools.execute(tool.name, {}, permission, signal);
    expect(permission.mock.calls.map(([name]) => name)).toEqual([
      `configured-mcp:${JSON.stringify([sourceIds[0], 'search'])}`,
      `configured-mcp:${JSON.stringify([sourceIds[1], 'docs__search'])}`,
    ]);
  } finally {
    await tools.close();
  }
});

it.each([0, 1])(
  'isolates opted-in grants from UUID-named legacy sources, approving source %s first',
  async (first) => {
    const sourceId = '11111111-1111-4111-8111-111111111111';
    const registry = new SessionRegistry();
    const requests: Record<string, unknown>[] = [];
    const abort = new AbortController();
    registry.register('mixed', {
      sessionId: 'mixed-conversation',
      transport: {
        send: (event) => {
          if (event.type === 'permission_request') requests.push(event);
        },
        isOpen: () => true,
      },
      abortController: abort,
      mode: 'agent',
      sessionAllowList: new Set(),
    });
    const calls = [vi.fn(async () => ({ content: [] })), vi.fn(async () => ({ content: [] }))];
    const tools = await connectCodexMcpTools(
      {
        docs: { command: 'configured', librarySourceId: sourceId },
        [sourceId]: { command: 'legacy' },
      },
      {
        cwd: '/fixture',
        env: {},
        signal: abort.signal,
        connect: async (config) => ({
          listTools: async () => ({ tools: [{ name: 'search', inputSchema: { type: 'object' } }] }),
          callTool: calls[config.command === 'configured' ? 0 : 1],
          close: async () => {},
        }),
      },
    );
    const permission = (name: string, input: Record<string, unknown>, signal: AbortSignal) =>
      buildPermissionHandler('mixed', registry)(name, input, { signal, toolUseID: name });
    let second: Promise<unknown> | undefined;
    try {
      const initial = tools.execute(tools.definitions[first].name, {}, permission, abort.signal);
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      expect(
        resolvePending(requests[0].permId as string, 'always', undefined, 'mixed-conversation'),
      ).toBe(true);
      await initial;
      expect(calls[first]).toHaveBeenCalledOnce();
      const other = 1 - first;
      second = tools.execute(tools.definitions[other].name, {}, permission, abort.signal);
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      expect(calls[other]).not.toHaveBeenCalled();
      expect(
        resolvePending(requests[1].permId as string, 'deny', undefined, 'mixed-conversation'),
      ).toBe(true);
      await second;
      expect(calls[other]).not.toHaveBeenCalled();
      await tools.execute(tools.definitions[first].name, {}, permission, abort.signal);
      expect(requests).toHaveLength(2);
      expect(calls[first]).toHaveBeenCalledTimes(2);
    } finally {
      abort.abort();
      await second?.catch(() => {});
      await tools.close();
      registry.dispose();
    }
  },
);

it.each([
  { matcher: '^mcp__docs__search$', deny: true },
  { matcher: '^mcp__', deny: true },
  { matcher: '^mcp__docs__search$', deny: false },
])(
  'preserves existing project-hook identity after source opt-in: $matcher, deny=$deny',
  async ({ matcher, deny }) => {
    const root = mkdtempSync(join(tmpdir(), 'configured-hook-identity-'));
    mkdirSync(join(root, '.claude'));
    writeFileSync(
      join(root, '.claude/settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher, hooks: [{ type: 'command', command: 'offline-hook-fixture' }] }],
        },
      }),
    );
    const runner = vi
      .fn<commands.ProtectedSdkCommandRunner>()
      .mockResolvedValue({
        stdout: JSON.stringify({
          hookSpecificOutput: deny
            ? {
                permissionDecision: 'deny',
                permissionDecisionReason: 'Project hook denied this tool',
              }
            : { updatedInput: { query: 'validated' } },
        }),
        stderr: '',
      });
    const runnerSpy = vi
      .spyOn(commands, 'createWorkspaceRuntimeCommandRunner')
      .mockReturnValue(runner);
    const hooks = new NativeHooks(root, 'hook-fixture', {});
    const callTool = vi.fn(async () => ({ content: [] }));
    const permission = vi.fn(async () => ({ behavior: 'allow' as const }));
    const signal = new AbortController().signal;
    const tools = await connectCodexMcpTools(
      {
        docs: { command: 'never-started', librarySourceId: '11111111-1111-4111-8111-111111111111' },
      },
      {
        cwd: root,
        env: {},
        signal,
        connect: async () => ({
          listTools: async () => ({ tools: [{ name: 'search', inputSchema: { type: 'object' } }] }),
          callTool,
          close: async () => {},
        }),
      },
    );
    try {
      const wire = tools.definitions[0].name;
      const result = await hooks.executeTool(
        tools.displayName(wire),
        { query: 'original' },
        signal,
        (input) => tools.execute(wire, input, permission, signal),
      );
      expect(runner).toHaveBeenCalledOnce();
      expect(JSON.parse(runner.mock.calls[0][2].input!).tool_name).toBe('mcp__docs__search');
      if (deny) {
        expect(result).toMatchObject({ isError: true, content: 'Project hook denied this tool' });
        expect(permission).not.toHaveBeenCalled();
        expect(callTool).not.toHaveBeenCalled();
      } else {
        expect(result.isError).toBe(false);
        expect(permission).toHaveBeenCalledWith(
          'configured-mcp:["11111111-1111-4111-8111-111111111111","search"]',
          { query: 'validated' },
          signal,
        );
        expect(callTool).toHaveBeenCalledWith(
          { name: 'search', arguments: { query: 'validated' } },
          signal,
        );
      }
    } finally {
      await tools.close();
      runnerSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
