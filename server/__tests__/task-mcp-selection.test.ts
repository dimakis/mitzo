import { expect, it, vi } from 'vitest';
import { AgentToolReferencesSchema } from '@mitzo/protocol';
import { agentToolCatalog } from '../agent-tool-catalog.js';
import {
  assertAgentToolRoute,
  bindAgentToolSelection,
  bindConfiguredAgentTools,
  filterAgentTools,
} from '../agent-tool-selection.js';
import {
  connectSelectedTaskMcpTools,
  selectedTaskMcpReferences,
  combineMcpToolPeers,
} from '../task-mcp-selection.js';
import { ConfiguredToolCatalog } from '../configured-tool-catalog.js';
import { admitConfiguredTools } from '../configured-tool-admission.js';

const ref = { id: 'mitzo:TaskStatus', version: 1 };
const scope = { clientId: 'worker-client', sessionId: 'worker-session', taskId: 'worker-task' };
function fixture() {
  const abort = new AbortController();
  const config = {
    command: 'original-task-server',
    args: [
      '--client-id',
      scope.clientId,
      '--session-id',
      scope.sessionId,
      '--task-id',
      scope.taskId,
    ],
    env: { MITZO_INTERNAL_TOKEN: 'synthetic-offline' },
  };
  const call = vi.fn(async () => ({ content: [{ type: 'text', text: 'original task result' }] }));
  const close = vi.fn(async () => {});
  const connect = vi.fn(async () => ({
    listTools: async () => ({
      tools: ['TaskStatus', 'TaskArtifact', 'TaskComplete', 'TaskBlock', 'TaskSet'].map((name) => ({
        name,
        inputSchema: { type: 'object' },
      })),
    }),
    callTool: call,
    close,
  }));
  const options = {
    cwd: '/tmp',
    env: {},
    signal: abort.signal,
    assertRuntimeCurrent: vi.fn(),
    connect,
  };
  return { abort, config, call, close, connect, options };
}
it('publishes original task operations as explicit owned-local refs, without permitting other routes or unknown versions', () => {
  const refs = ['TaskStatus', 'TaskArtifact', 'TaskComplete', 'TaskBlock'].map((name) => ({
    id: `mitzo:${name}`,
    version: 1,
  }));
  expect(AgentToolReferencesSchema.parse(refs)).toEqual(refs);
  expect(
    selectedTaskMcpReferences({
      tools: [...refs, { id: 'mitzo:TelosReadArtifact', version: 1 }],
    } as never),
  ).toEqual(refs);
  for (const task of refs) {
    expect(agentToolCatalog().find((entry) => entry.id === task.id)).toMatchObject({
      required: false,
      routes: ['codex-owned-local'],
    });
    expect(() =>
      assertAgentToolRoute({ tools: [task] } as never, 'codex-owned-local'),
    ).not.toThrow();
    for (const route of ['codex', 'local-api', 'openshell'])
      expect(() => assertAgentToolRoute({ tools: [task] } as never, route)).toThrow();
  }
  for (const bad of [
    { id: 'mitzo:TaskStatus', version: 2 },
    { id: 'mitzo:TaskSet', version: 1 },
  ])
    expect(() => assertAgentToolRoute({ tools: [bad] } as never, 'codex-owned-local')).toThrow();
});
it.each([
  'missing',
  'foreign-client',
  'foreign-session',
  'foreign-task',
  'duplicate-scope',
  'configured-source',
  'sandbox',
  'unknown-ref',
])('refuses %s before starting any MCP process', async (kind) => {
  const f = fixture();
  const configs: Record<
    string,
    typeof f.config & { librarySourceId?: string; execution?: 'sandbox' }
  > = { 'task-board': f.config };
  let refs = [ref];
  if (kind === 'missing') delete configs['task-board'];
  if (kind === 'foreign-client') f.config.args[1] = 'other-client';
  if (kind === 'foreign-session') f.config.args[3] = 'other-session';
  if (kind === 'foreign-task') f.config.args[5] = 'other-task';
  if (kind === 'duplicate-scope') f.config.args.push('--task-id', scope.taskId);
  if (kind === 'configured-source')
    configs['task-board'].librarySourceId = '11111111-1111-4111-8111-111111111111';
  if (kind === 'sandbox') configs['task-board'].execution = 'sandbox';
  if (kind === 'unknown-ref') refs = [{ id: 'mitzo:TaskSet', version: 1 }];
  await expect(connectSelectedTaskMcpTools(refs, configs, scope, f.options)).rejects.toThrow(
    /original scoped host task server/,
  );
  expect(f.connect).not.toHaveBeenCalled();
  expect(f.call).not.toHaveBeenCalled();
});
it('closes the original peer if a selected operation is absent and never substitutes a sibling operation', async () => {
  const f = fixture();
  f.connect.mockResolvedValueOnce({
    listTools: async () => ({ tools: [{ name: 'TaskBlock', inputSchema: { type: 'object' } }] }),
    callTool: f.call,
    close: f.close,
  });
  await expect(
    connectSelectedTaskMcpTools([ref], { 'task-board': f.config }, scope, f.options),
  ).rejects.toThrow(/operation is unavailable/);
  expect(f.close).toHaveBeenCalledOnce();
  expect(f.call).not.toHaveBeenCalled();
});
it('keeps configured receipt tools and scoped task tools together without launching an ambient source or expanding either selection', async () => {
  const f = fixture();
  const catalog = new ConfiguredToolCatalog(':memory:');
  const sources = {
    selected: { command: 'selected-peer', librarySourceId: '11111111-1111-4111-8111-111111111111' },
    ambient: { command: 'ambient-peer', librarySourceId: '22222222-2222-4222-8222-222222222222' },
  };
  const configuredCall = vi.fn(async () => ({
    content: [{ type: 'text', text: 'configured result' }],
  }));
  const configuredClose = vi.fn(async () => {});
  const connect = vi.fn(async () => ({
    listTools: async () => ({
      tools: ['search', 'unselected'].map((name) => ({ name, inputSchema: { type: 'object' } })),
    }),
    callTool: configuredCall,
    close: configuredClose,
  }));
  const options = { ...f.options, connect, readSources: () => sources };
  let peers: ReturnType<typeof combineMcpToolPeers> | undefined;
  try {
    const entry = (await catalog.refresh(options)).find(
      (entry) => entry.source === 'selected' && entry.name === 'search',
    )!;
    connect.mockClear();
    configuredClose.mockClear();
    const configured = await admitConfiguredTools(catalog, [catalog.reference(entry)], options);
    const task = await connectSelectedTaskMcpTools(
      [ref],
      { 'task-board': f.config, ambient: { command: 'must-not-start' } },
      scope,
      f.options,
    );
    peers = combineMcpToolPeers(configured, task);
    const session = {};
    bindAgentToolSelection(
      session,
      {
        tools: [ref, catalog.reference(entry), { id: 'mitzo:TelosReadArtifact', version: 1 }],
      } as never,
      'codex-owned-local',
    );
    bindConfiguredAgentTools(session, [...configured.admitted, ...task.admitted]);
    expect(
      filterAgentTools(session, [
        ...peers.definitions,
        { name: 'TelosReadArtifact' },
        { name: 'Write' },
        { name: 'mitzo_mcp_forged' },
      ]),
    ).toHaveLength(3);
    expect(connect).toHaveBeenCalledOnce();
    expect(f.connect).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'selected-peer' }),
      expect.anything(),
    );
    const permission = vi.fn(async () => ({ behavior: 'allow' as const }));
    for (const tool of peers.definitions)
      expect((await peers.execute(tool.name, {}, permission, f.abort.signal)).isError).toBe(false);
    expect(permission).toHaveBeenCalledWith('mcp__task-board__TaskStatus', {}, f.abort.signal);
    expect(permission).toHaveBeenCalledWith(
      'mcp__selected__search',
      {},
      f.abort.signal,
      expect.objectContaining({ sessionGrantKey: expect.stringContaining('configured-mcp:') }),
    );
    expect(f.call).toHaveBeenCalledOnce();
    expect(configuredCall).toHaveBeenCalledOnce();
    await expect(async () =>
      peers!.execute('mcp__task-board__TaskSet', {}, permission, f.abort.signal),
    ).rejects.toThrow(/not selected/);
    f.call.mockClear();
    expect(
      (
        await peers.execute(
          task.definitions[0].name,
          {},
          async () => ({ behavior: 'deny' }),
          f.abort.signal,
        )
      ).isError,
    ).toBe(true);
    expect(f.call).not.toHaveBeenCalled();
    await expect(
      peers.execute(
        task.definitions[0].name,
        {},
        async () => {
          f.abort.abort();
          return { behavior: 'allow' };
        },
        f.abort.signal,
      ),
    ).rejects.toThrow();
    expect(f.call).not.toHaveBeenCalled();
  } finally {
    await peers?.close();
    catalog.close();
  }
  expect(f.close).toHaveBeenCalledOnce();
  expect(configuredClose).toHaveBeenCalledOnce();
});
