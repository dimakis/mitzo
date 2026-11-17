import { beforeEach, expect, it, vi } from 'vitest';
import type {
  AccountProvider,
  SessionLaunchConfig,
  SymposiumProfileDefinition,
} from '@mitzo/protocol';
import {
  createSessionLaunchPort,
  prepareTelosSessionSettings,
  qualifyTelosSessionLaunchConfig,
  SESSION_LAUNCH_ENGINE_UNSUPPORTED,
  TELOS_SESSION_CODEX_ONLY,
  sessionLaunchStartupBlocker,
} from '../session-launch-runtime.js';
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
  sdkCustody: vi.fn(),
  sdkAdmission: vi.fn(),
  sdkEvidence: vi.fn(),
  inventoryHarness: vi.fn(),
  selectedTools: undefined as SymposiumProfileDefinition['tools'],
  binding: {
    accountId: 'personal',
    accountLabel: 'Personal',
    provider: 'openai-codex' as AccountProvider,
    profileRevision: 'v1',
    model: 'fixture-model',
  },
  runtime: {
    version: 2 as const,
    account: {
      accountId: 'personal',
      provider: 'openai-codex' as AccountProvider,
      profileRevision: 'v1',
    },
    harness: { implementation: 'codex' as 'codex' | 'claude-sdk' },
    execution: { location: 'local' as const, targetId: 'mac', targetRevision: 'target-v1' },
  },
}));
const codexRuntime = structuredClone(mocks.runtime);
const codexBinding = structuredClone(mocks.binding);
function selectClaudeRoute() {
  mocks.binding = { ...codexBinding, provider: 'anthropic-claude' };
  mocks.runtime = {
    ...codexRuntime,
    account: { ...codexRuntime.account, provider: 'anthropic-claude' },
    harness: { implementation: 'claude-sdk' },
  };
}
vi.mock('../agent-library-transport.js', () => ({
  captureAgentLibraryAuthorization: () => ({ auth: { id: 'login' }, assertCurrent: () => {} }),
}));
vi.mock('../account-profiles.js', () => ({
  loadAccountProfiles: () => ({ resolve: () => mocks.binding, validateModelSelection: () => {} }),
}));
vi.mock('../ordinary-local-codex-entry.js', () => ({
  ordinaryRepositoryRuntimeInventory: (location: string, harness: string) => ({
    ...(mocks.inventoryHarness(location, harness) ?? {}),
    catalog: { resolve: () => ({ status: 'compatible', binding: mocks.runtime }) },
    result: {
      capabilityRevision: 'catalog-v1',
      routes: [
        {
          account: mocks.runtime.account,
          harness: mocks.runtime.harness.implementation,
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
    definition: { name: 'Default', tools: mocks.selectedTools },
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
    getOrdinaryLocalVertexCustody: mocks.sdkCustody,
    getOrdinaryLocalVertexCommandAdmission: mocks.sdkAdmission,
    getSession: mocks.sessionMeta,
    removals: { assertAdmissible: mocks.removalFence },
  },
  registry: { findBySessionId: () => null },
}));
vi.mock('../ordinary-sdk-turn-evidence.js', () => ({
  readOrdinarySdkTurnDiagnostic: mocks.sdkEvidence,
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
  mocks.selectedTools = undefined;
  mocks.binding = structuredClone(codexBinding);
  mocks.runtime = structuredClone(codexRuntime);
  mocks.sdkCustody.mockReturnValue(undefined);
  mocks.sdkAdmission.mockReturnValue(undefined);
  mocks.sdkEvidence.mockReturnValue({ inputAcknowledged: false });
  mocks.prepare.mockImplementation(async () => ({
    preparationId: 'preparation',
    runtimeBinding: mocks.runtime,
  }));
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
  mocks.preparation.mockImplementation(() => ({
    sessionId: 'child',
    settings: { binding: mocks.runtime, workspace: { preparationId: 'preparation' } },
  }));
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
it('prepares the independent Telos child tuple without allocating a session or command', async () => {
  const settings = await prepareTelosSessionSettings(configuration, authority);
  expect(settings).toMatchObject({
    version: 2,
    binding: mocks.runtime,
    selection: {
      agent: configuration.runtime.agentProfile,
      model: 'fixture-model',
      permission: { mode: 'agent' },
    },
  });
  expect(mocks.prepare).toHaveBeenCalledOnce();
  expect(mocks.reserve).not.toHaveBeenCalled();
  expect(mocks.prepareSession).not.toHaveBeenCalled();
  expect(mocks.dispatch).not.toHaveBeenCalled();
});
it('refuses repository preparation without native primitives before any workspace effect', async () => {
  mocks.selectedTools = [{ id: 'mitzo:PrepareLocalRepository', version: 1 }];
  const selected = {
    ...record,
    configuration: { ...configuration, extraTools: ['PrepareLocalRepository'] },
  };
  await expect(createSessionLaunchPort().start(selected, authority, vi.fn())).rejects.toThrow(
    /Bash.*Read.*Write.*Edit/,
  );
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.reserve).not.toHaveBeenCalled();
  expect(mocks.prepareSession).not.toHaveBeenCalled();
  expect(mocks.dispatch).not.toHaveBeenCalled();
});
it.each(['openshell', 'claude'] as const)(
  'rejects an unsupported Telos child %s route before preparation',
  async (route) => {
    const selected = structuredClone(configuration);
    if (route === 'openshell')
      selected.runtime.execution = { location: 'openshell', targetId: 'shell' };
    else
      selected.runtime.accountReference = {
        accountId: 'claude',
        provider: 'claude',
        profileRevision: 'v1',
      } as never;
    await expect(prepareTelosSessionSettings(selected, authority)).rejects.toThrow();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.prepareSession).not.toHaveBeenCalled();
  },
);
function claudeConfiguration(provider = 'anthropic-claude'): SessionLaunchConfig {
  const selected = structuredClone(configuration);
  selected.runtime.accountReference = {
    accountId: 'personal',
    provider,
    profileRevision: 'v1',
  } as never;
  return selected;
}
it.each(['anthropic-claude', 'anthropic-vertex', 'anthropic-api'])(
  'allows a %s account at proposal',
  (provider) => {
    expect(sessionLaunchStartupBlocker(configuration)).toBeNull();
    expect(sessionLaunchStartupBlocker(claudeConfiguration(provider))).toBeNull();
  },
);
it.each(['google-vertex', 'unknown-provider'])(
  'reports an unsupported %s engine at proposal',
  (provider) => {
    expect(sessionLaunchStartupBlocker(claudeConfiguration(provider))).toBe(
      SESSION_LAUNCH_ENGINE_UNSUPPORTED,
    );
  },
);
it('keeps Telos child sessions on Codex before any workspace effect', async () => {
  selectClaudeRoute();
  const claude = claudeConfiguration();
  await expect(qualifyTelosSessionLaunchConfig(claude, authority)).rejects.toThrow(
    TELOS_SESSION_CODEX_ONLY,
  );
  await expect(prepareTelosSessionSettings(claude, authority)).rejects.toThrow(
    TELOS_SESSION_CODEX_ONLY,
  );
  // A saved Codex reference whose account now resolves to Claude is also refused.
  await expect(prepareTelosSessionSettings(configuration, authority)).rejects.toThrow();
  expect(mocks.prepare).not.toHaveBeenCalled();
});
it('starts a Claude child through the owned ordinary Claude SDK route', async () => {
  selectClaudeRoute();
  const selected = { ...record, configuration: claudeConfiguration() };
  const prepared = vi.fn();
  await createSessionLaunchPort().start(selected, authority, prepared);
  expect(mocks.inventoryHarness).toHaveBeenCalledWith('local', 'claude-sdk');
  expect(mocks.prepare.mock.calls[0][0].selection.runtime).toMatchObject({
    harness: 'claude-sdk',
    account: { provider: 'anthropic-claude' },
  });
  expect(prepared).toHaveBeenCalledWith('child', 'preparation');
  const call = mocks.dispatch.mock.calls[0][0];
  expect(call).toMatchObject({
    commandId: 'command',
    preparationOperationId: 'allocation',
    workspaceKind: 'ordinary',
    ownerAuthSessionId: 'login',
    command: {
      runtime: {
        harness: 'claude-sdk',
        account: { provider: 'anthropic-claude' },
        mode: 'agent',
      },
      selection: { context: { source: 'none', revision: null }, model: 'fixture-model' },
      payload: { text: 'Reviewed handoff' },
    },
  });
});
it('rejects a Claude account whose saved reference is missing or changed', async () => {
  selectClaudeRoute();
  await expect(createSessionLaunchPort().start(record, authority, vi.fn())).rejects.toThrow(
    /saved account identity changed/i,
  );
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.dispatch).not.toHaveBeenCalled();
});
it('reports a Claude child running only after the exact SDK input acknowledgement', async () => {
  selectClaudeRoute();
  const selected = { ...record, configuration: claudeConfiguration() };
  const port = createSessionLaunchPort();
  mocks.sdkAdmission.mockReturnValue({ state: 'consumed' });
  expect(await port.inspect(selected, authority)).toMatchObject({
    accepted: false,
    uncertain: true,
    childSessionId: 'child',
  });
  expect(mocks.sdkEvidence).toHaveBeenCalledWith(expect.anything(), 'child', 'command');
  expect(mocks.ack).not.toHaveBeenCalled();
  mocks.sdkEvidence.mockReturnValue({ inputAcknowledged: true });
  expect(await port.inspect(selected, authority)).toMatchObject({ accepted: true });
  mocks.sdkAdmission.mockReturnValue({ state: 'reserved' });
  expect(await port.inspect(selected, authority)).toMatchObject({ accepted: false });
});
it('treats unreadable Claude startup evidence as uncertain, never accepted', async () => {
  selectClaudeRoute();
  mocks.sdkAdmission.mockReturnValue({ state: 'consumed' });
  mocks.sdkEvidence.mockImplementation(() => {
    throw Error('Ambiguous ordinary SDK turn evidence');
  });
  expect(
    await createSessionLaunchPort().inspect(
      { ...record, configuration: claudeConfiguration() },
      authority,
    ),
  ).toMatchObject({ accepted: false, uncertain: true });
});
it('refuses Claude resume once SDK custody exists for the child', async () => {
  selectClaudeRoute();
  mocks.workspaceOperation.mockReturnValue({ conversationId: 'child' });
  mocks.hasNative.mockReturnValue(false);
  mocks.sdkCustody.mockReturnValue({ sessionId: 'child' });
  await expect(
    createSessionLaunchPort().canResume!(
      { ...record, configuration: claudeConfiguration() },
      authority,
    ),
  ).rejects.toThrow(/native execution history/i);
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
  { ...configuration, extraTools: ['TelosStartSlice'] },
  { ...configuration, extraTools: ['TelosWorkControl'] },
  { ...configuration, extraTools: ['TelosCreateSession'] },
  { ...configuration, extraTools: ['TelosSaveArtifact', 'TelosReadArtifact'] },
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
