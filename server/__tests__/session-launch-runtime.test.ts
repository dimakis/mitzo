import { beforeEach, expect, it, vi } from 'vitest';
import type { SessionLaunchConfig } from '@mitzo/protocol';
import { createSessionLaunchPort } from '../session-launch-runtime.js';
import type { RetainedSessionLaunch } from '../session-launch-store.js';
const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  reserve: vi.fn(),
  prepareSession: vi.fn(),
  dispatch: vi.fn(),
  ack: vi.fn(),
  commands: vi.fn(),
  workspaceOperation: vi.fn(),
  revalidate: vi.fn(),
  preparation: vi.fn(),
  sendCommand: vi.fn(),
  hasNative: vi.fn(),
  sessionMeta: vi.fn(),
  removalFence: vi.fn(),
  upsert: vi.fn(),
  rename: vi.fn(),
  binding: {
    accountId: 'personal',
    accountLabel: 'Personal',
    provider: 'openai-codex' as const,
    profileRevision: 'v1',
    model: 'fixture-model',
  },
  runtime: {
    version: 2 as const,
    account: { accountId: 'personal', provider: 'openai-codex' as const, profileRevision: 'v1' },
    harness: { implementation: 'codex' as const },
    execution: { location: 'local' as const, targetId: 'mac', targetRevision: 'target-v1' },
  },
}));
vi.mock('../agent-library-transport.js', () => ({
  captureAgentLibraryAuthorization: () => ({ auth: { id: 'login' }, assertCurrent: () => {} }),
}));
vi.mock('../account-profiles.js', () => ({
  loadAccountProfiles: () => ({ resolve: () => mocks.binding, validateModelSelection: () => {} }),
}));
vi.mock('../ordinary-local-codex-entry.js', () => ({
  ordinaryRepositoryRuntimeInventory: () => ({
    catalog: { resolve: () => ({ status: 'compatible', binding: mocks.runtime }) },
    result: {
      capabilityRevision: 'catalog-v1',
      routes: [
        {
          account: mocks.runtime.account,
          harness: 'codex',
          targetId: 'mac',
          modes: ['ask', 'agent', 'auto'],
        },
      ],
      accounts: [
        {
          account: mocks.runtime.account,
          modelDiscovery: { stale: false },
          models: [{ id: 'fixture-model', reasoningEfforts: ['high'] }],
        },
      ],
    },
  }),
}));
vi.mock('../agent-library-runtime.js', () => ({ getAgentLibrary: () => ({}) }));
vi.mock('../ordinary-codex-agent-profile.js', () => ({
  readOrdinaryCodexAgentProfile: () => ({
    profileId: 'default',
    revision: 1,
    kind: 'builtin',
    definition: { name: 'Default' },
  }),
  ordinaryCodexAgentProfileRouteProjection: () => ({ agentProfileRejections: [] }),
}));
vi.mock('../repository-workspace-runtime.js', () => ({
  getOrdinaryWorkspaces: () => ({
    prepareOrdinaryWorkspace: mocks.prepare,
    reserveOrdinaryWorkspace: mocks.reserve,
    getOrdinaryWorkspaceForOperation: mocks.workspaceOperation,
    revalidateOrdinaryWorkspace: mocks.revalidate,
  }),
}));
vi.mock('../ordinary-workspace-runtime.js', () => ({
  ordinaryWorkspaceTaskRoot: () => '/ordinary-root',
}));
vi.mock('../ordinary-scoped-command.js', () => ({ dispatchOwnedOrdinaryCommand: mocks.dispatch }));
vi.mock('../chat.js', () => ({
  eventStore: {
    prepareOrdinaryWorkspaceSession: mocks.prepareSession,
    upsertSession: mocks.upsert,
    markManuallyRenamed: mocks.rename,
    getOrdinaryWorkspaceSessionPreparation: mocks.preparation,
    getSendCommand: mocks.sendCommand,
    getOrdinaryCommandAdmission: () => ({ state: 'consumed' }),
    getSession: mocks.sessionMeta,
    removals: { assertAdmissible: mocks.removalFence },
  },
  registry: { findBySessionId: () => null },
}));
vi.mock('../codex-chat-session.js', () => ({
  getCodexConversationStore: () => ({
    hasConversation: mocks.hasNative,
    acceptedProviderTurnForCommand: mocks.ack,
    commands: mocks.commands,
  }),
}));
const configuration: SessionLaunchConfig = {
  version: 1,
  runtime: {
    version: 1,
    account: { accountId: 'personal', model: 'fixture-model', reasoningEffort: 'high' },
    accountReference: mocks.runtime.account,
    agentProfile: { profileId: 'default', revision: 1, kind: 'builtin' },
    execution: { location: 'local', targetId: 'mac' },
  },
  mode: 'agent',
  isolation: true,
  repositoryWorkspaceId: null,
  contextBlocks: [],
  extraTools: [],
};
const record = {
  proposalId: 'proposal',
  title: 'Reviewed title',
  prompt: 'Reviewed handoff',
  configuration,
  allocationId: 'allocation',
  commandId: 'command',
} as RetainedSessionLaunch;
const authority = {
  operatorConnectionId: 'authenticated-operation',
  authSessionId: 'login',
  signal: new AbortController().signal,
  assertCurrent: () => {},
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.prepare.mockResolvedValue({ preparationId: 'preparation', runtimeBinding: mocks.runtime });
  mocks.reserve.mockImplementation(async (input) => ({
    id: 'workspace',
    conversationId: 'child',
    directory: '/ordinary-root/child',
    hostReservation: { taskRoot: '/ordinary-root' },
    preparationFingerprint: 'fingerprint',
    settings: input.settings,
    preparationId: input.preparationId,
    binding: input.binding,
    agentProfile: input.agentProfile,
  }));
  mocks.dispatch.mockResolvedValue({ dispatched: true, sessionId: 'child' });
  mocks.ack.mockReturnValue(undefined);
  mocks.preparation.mockReturnValue({
    sessionId: 'child',
    settings: { workspace: { preparationId: 'preparation' } },
  });
  mocks.sendCommand.mockReturnValue({ sessionId: 'child' });
  mocks.hasNative.mockReturnValue(true);
  mocks.sessionMeta.mockReturnValue({ accountBinding: mocks.binding });
  mocks.removalFence.mockImplementation(() => {});
  mocks.workspaceOperation.mockReturnValue(undefined);
  mocks.revalidate.mockResolvedValue(undefined);
  mocks.commands.mockReturnValue([
    { id: 'command', prompt: 'Reviewed handoff', model: 'fixture-model', reasoningEffort: 'high' },
  ]);
});
it('reuses ordinary native dispatch with the approved choices and durable IDs', async () => {
  const port = createSessionLaunchPort();
  const prepared = vi.fn();
  await port.start(record, authority, prepared);
  expect(prepared).toHaveBeenCalledWith('child', 'preparation');
  const call = mocks.dispatch.mock.calls[0][0];
  expect(call).toMatchObject({
    commandId: 'command',
    preparationOperationId: 'allocation',
    workspaceKind: 'ordinary',
    command: {
      payload: { text: 'Reviewed handoff' },
      selection: {
        permission: { mode: 'agent', revision: 0 },
        model: 'fixture-model',
        thinking: 'high',
      },
    },
  });
  expect(call.transport.isOpen()).toBe(true);
  expect(call).not.toHaveProperty('adviserScope');
  expect(mocks.upsert).toHaveBeenCalledWith({ sessionId: 'child', summary: 'Reviewed title' });
});
it('starts with the coordinator tools exposed by the selected default profile', async () => {
  const selected = {
    ...record,
    configuration: {
      ...configuration,
      extraTools: ['AgentCommunication', 'TaskExecution', 'StartSession', 'SessionTimers'],
    },
  };
  await createSessionLaunchPort().start(selected, authority, vi.fn());
  expect(mocks.dispatch).toHaveBeenCalledOnce();
  expect(mocks.dispatch.mock.calls[0][0].command.selection.agent).toEqual(
    configuration.runtime.agentProfile,
  );
});
it.each([
  {
    ...configuration,
    runtime: {
      ...configuration.runtime,
      execution: { location: 'openshell' as const, targetId: 'shell' },
    },
  },
  { ...configuration, isolation: false },
  { ...configuration, repositoryWorkspaceId: 'parent-workspace' },
  { ...configuration, contextBlocks: ['private-context'] },
  { ...configuration, extraTools: ['tool'] },
  { ...configuration, runtime: { ...configuration.runtime, accountReference: null } },
])('rejects unsupported or changed selections before workspace effects', async (config) => {
  await expect(createSessionLaunchPort().validate(config, authority)).rejects.toThrow();
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.dispatch).not.toHaveBeenCalled();
});
it('does not report running from allocation or consumed admission without a provider ACK', async () => {
  const port = createSessionLaunchPort();
  expect(await port.inspect(record, authority)).toMatchObject({
    accepted: false,
    childSessionId: 'child',
  });
  mocks.ack.mockReturnValue({ threadId: 'thread', turnId: 'turn' });
  expect(await port.inspect(record, authority)).toMatchObject({ accepted: true });
  expect(mocks.ack).toHaveBeenLastCalledWith('child', mocks.binding, 'command');
});
it('accepts an expanded skill prompt only when its raw reviewed intent and command identity match', async () => {
  const port = createSessionLaunchPort();
  mocks.commands.mockReturnValue([
    {
      id: 'command',
      prompt: 'Expanded skill instructions',
      intent: 'Reviewed handoff',
      model: 'fixture-model',
      reasoningEffort: 'high',
    },
  ]);
  mocks.ack.mockReturnValue({ threadId: 'thread', turnId: 'turn' });
  expect(await port.inspect(record, authority)).toMatchObject({ accepted: true });
  mocks.commands.mockReturnValue([
    {
      id: 'command',
      prompt: 'Expanded skill instructions',
      intent: 'Unreviewed handoff',
      model: 'fixture-model',
      reasoningEffort: 'high',
    },
  ]);
  expect(await port.inspect(record, authority)).toMatchObject({ accepted: false });
});
it('resumes the existing reservation without a replacement preparation, workspace or command identity', async () => {
  const port = createSessionLaunchPort();
  await port.start(record, authority, vi.fn());
  const saved = await mocks.reserve.mock.results[0].value;
  mocks.workspaceOperation.mockReturnValue(saved);
  mocks.hasNative.mockReturnValue(false);
  mocks.sendCommand.mockReturnValue(undefined);
  mocks.preparation.mockReturnValue(undefined);
  mocks.prepare.mockClear();
  mocks.reserve.mockClear();
  mocks.dispatch.mockClear();
  const onPrepared = vi.fn();
  await port.resume!(record, authority, onPrepared);
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.reserve).not.toHaveBeenCalled();
  expect(mocks.revalidate).toHaveBeenCalledWith({
    id: 'workspace',
    conversationId: 'child',
    binding: mocks.binding,
    taskRoot: '/ordinary-root',
    signal: authority.signal,
  });
  expect(onPrepared).toHaveBeenCalledWith('child', 'preparation');
  expect(mocks.dispatch).toHaveBeenCalledWith(
    expect.objectContaining({ commandId: 'command', preparationOperationId: 'allocation' }),
  );
});
it('refuses explicit resume whenever native history or an admitted command exists', async () => {
  const port = createSessionLaunchPort();
  mocks.workspaceOperation.mockReturnValue({ conversationId: 'child' });
  await expect(port.canResume!(record, authority)).rejects.toThrow(/native execution history/i);
  mocks.hasNative.mockReturnValue(false);
  await expect(port.canResume!(record, authority)).rejects.toThrow(/admitted command/i);
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.dispatch).not.toHaveBeenCalled();
});
it.each(['hidden', 'removing'])(
  'refuses %s child recovery before metadata or title writes',
  async (reason) => {
    const port = createSessionLaunchPort();
    mocks.workspaceOperation.mockReturnValue({ conversationId: 'child' });
    if (reason === 'hidden')
      mocks.sessionMeta.mockReturnValue({ accountBinding: mocks.binding, isHidden: true });
    else
      mocks.removalFence.mockImplementation(() => {
        throw Error('This chat is being removed');
      });
    await expect(
      port.resume!({ ...record, childSessionId: 'child' }, authority, vi.fn()),
    ).rejects.toThrow(/hidden|removed/);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.prepareSession).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  },
);
it.each(['metadata', 'child-link'])(
  'refuses replacement allocation after loss of original custody with a retained %s',
  async (source) => {
    const port = createSessionLaunchPort();
    mocks.workspaceOperation.mockReturnValue(undefined);
    mocks.hasNative.mockReturnValue(false);
    mocks.sendCommand.mockReturnValue(undefined);
    if (source === 'child-link') mocks.preparation.mockReturnValue(undefined);
    const retained = { ...record, childSessionId: source === 'child-link' ? 'child' : null };
    await expect(port.resume!(retained, authority, vi.fn())).rejects.toThrow(
      /ownership.*unavailable/i,
    );
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  },
);
