import {
  AgentLibraryVersionSchema,
  CollaborationSettingsSchema,
  OrdinaryWorkspaceSettingsSchema,
} from '@mitzo/protocol';
import { contextDigest } from '../agent-context-compiler.js';
import { assembleSourceSnapshots } from '../source-snapshot-context.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { CodexConversationStore } from '../codex-conversation-store.js';
import { EventStore } from '../event-store.js';
import { AccountProfiles } from '../account-profiles.js';
import type { RepositoryWorkspaces } from '../repository-workspaces.js';
import type { OpenShellRuntimeConfig } from '../openshell-runtime.js';
import {
  ordinaryOpenShellCodexTarget,
  projectOrdinaryOpenShellCodexCapabilities,
} from '../ordinary-openshell-codex-route.js';
import { OrdinaryOpenShellCodexOwnedRuntime } from '../ordinary-openshell-codex-owned-runtime.js';

vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}), getMcpConfigPaths: () => [] }));

const stores: EventStore[] = [];
const natives: CodexConversationStore[] = [];
const roots: string[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  natives.splice(0).forEach((store) => store.close());
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
function fixture(ordinary = false, existingEvents?: EventStore) {
  const workspaceId = ordinary ? randomUUID() : 'repo';
  const events = existingEvents ?? new EventStore(':memory:');
  stores.push(events);
  const profiles = new AccountProfiles(
    [
      {
        id: 'personal',
        label: 'Personal',
        provider: 'openai-codex',
        email: 'fixture@example.test',
        planType: 'plus',
        sandboxProvider: 'provider',
        sandboxProviderType: 'openai-codex-oauth',
        sandboxProviderId: 'provider-id',
        sandboxGrantId: 'grant-id',
        models: [
          { id: 'first', label: 'First', reasoningEfforts: ['low'] },
          { id: 'next', label: 'Next', reasoningEfforts: ['high'] },
        ],
      },
    ],
    { codexEnabled: true },
  );
  const root = mkdtempSync(join(tmpdir(), 'mitzo-openshell-owner-'));
  roots.push(root);
  let native = new CodexConversationStore(join(root, 'native.db'));
  natives.push(native);
  const account = profiles.resolve('personal', 'first');
  const config: OpenShellRuntimeConfig = {
    cli: '/fixture/cli',
    image: 'fixture',
    policy: '/fixture/policy',
    seed: '/fixture/seed',
    serviceProviders: [],
    grantableServiceProviders: [],
    workspace: 'workspace',
    gateway: 'gateway',
    gatewayInsecure: false,
    createDetached: true,
    sandboxIdLength: 24,
    workdir: '/sandbox/workspaces/task',
    webSearch: 'disabled',
  };
  const target = ordinaryOpenShellCodexTarget({
    targetId: 'target',
    runtimeContractRevision: 'contract',
    config,
    openaiApi: 'disabled',
  });
  const projection = projectOrdinaryOpenShellCodexCapabilities({
    profiles,
    target,
    deployment: 'ordinary',
  });
  const agentProfile = AgentLibraryVersionSchema.parse({
    profileId: 'agent',
    revision: 1,
    contentHash: 'a'.repeat(64),
    definition: {
      name: 'Agent',
      descriptor: 'Fixture',
      role: 'agent' as const,
      instructions: 'Offline',
      expectedOutput: 'Evidence',
      acceptanceCriteria: ['Evidence'],
      modelPolicyRole: 'agent' as const,
    },
  });
  agentProfile.contentHash = contextDigest(agentProfile.definition);
  const meta = {
    sessionId: 'session',
    ...(ordinary ? { ordinaryWorkspaceId: workspaceId } : { repositoryWorkspaceId: workspaceId }),
    cwd: config.workdir,
    accountBinding: account,
    selectedModel: 'first',
    reasoningEffort: 'low',
    mode: 'agent' as const,
    agentProfile,
  };
  const command = (id: string, model = 'first', thinking = 'low') => ({
    clientMsgId: id,
    capabilityRevision: projection.inventory.capabilityRevision,
    runtime: {
      account: {
        accountId: account.accountId,
        provider: account.provider,
        profileRevision: account.profileRevision,
      },
      targetId: target.targetId,
      harness: 'codex',
      mode: 'agent',
    },
    selection: {
      version: 1,
      agent: { profileId: 'agent', revision: 1 },
      context: { source: 'none', revision: null },
      permission: { mode: 'agent', revision: 0 },
      model,
      thinking,
    },
    payload: { text: `message ${id}`, systemPrompt: 'Frozen instructions' },
  });
  const claim = vi.fn(async () => ({
    id: 'repo',
    state: 'claimed',
    sandbox: true,
    conversationId: 'session',
    binding: account,
    featureBranch: 'branch',
    connectionId: 'github',
    connectionRevision: 1,
    repository: 'owner/repo',
    baseBranch: 'main',
    baseOid: 'a'.repeat(40),
    createdAt: 1,
  }));
  const claimOrdinaryWorkspace = vi.fn(async () => ({
    kind: 'ordinary',
    id: workspaceId,
    state: 'claimed',
    sandbox: true,
    directory: config.workdir,
    conversationId: 'session',
    binding: account,
  }));
  const preparationOperationId = ordinary ? randomUUID() : undefined;
  if (preparationOperationId)
    events.prepareOrdinaryWorkspaceSession(meta, {
      allocationOperationId: preparationOperationId,
      preparationFingerprint: 'a'.repeat(64),
      settings: OrdinaryWorkspaceSettingsSchema.parse({
        version: 2,
        binding: {
          version: 2,
          account: command('settings').runtime.account,
          harness: { implementation: 'codex' },
          execution: {
            location: 'openshell',
            targetId: target.targetId,
            targetRevision: target.targetRevision,
          },
        },
        selection: command('settings').selection,
        workspace: { kind: 'ordinary', preparationId: randomUUID() },
      }),
    });
  let opened = false;
  const artifact = {
    runtime: {
      sandboxName: 'sandbox-session',
      sandboxId: `physical-${root.split('/').pop()}`,
      workdir: config.workdir,
      appServerCommand: '/sandbox/run-mitzo-subscription-app-server' as const,
      cli: config.cli,
      gateway: config.gateway,
      workspace: config.workspace,
      gatewayInsecure: false,
    },
    route: {
      kind: 'chatgpt-subscription' as const,
      provider: 'provider',
      providerType: 'openai-codex-oauth' as const,
      providerId: 'provider-id',
      grantId: 'grant-id',
      model: 'first',
    },
  };
  native.create('session', account, config.workdir);
  let currentAdmission:
    | import('../owned-openshell-codex-chat-admission.js').OwnedOpenShellCodexChatAdmission
    | undefined;
  const pump = () => {
    if (!currentAdmission) return;
    while (true) {
      const next = native
        .commands('session', account)
        .find((command) => command.status === 'queued');
      if (!next || !currentAdmission.canClaimCommand(next.id)) return;
      const claimed = native.claimNext('session', account)!;
      currentAdmission.assertBeforeDispatch(claimed.id);
      native.finish('session', account, claimed.id, 'completed', `turn-${claimed.id}`);
    }
  };
  const dispatch = vi.fn(async (input) => {
    currentAdmission = input.admission;
    expect(events.getOrdinaryOpenShellCommandAdmission(input.commandId)?.state).toBe('uncertain');
    if (!opened) {
      input.admission.assertOptions({
        conversationId: 'session',
        messageId: input.commandId,
        binding: input.account,
        profile: input.profile,
        session: { cwd: config.workdir, mode: 'agent' },
        prompt: assembleSourceSnapshots(input.payload.text, input.payload.sourceSnapshots),
        intent: input.payload.intent ?? input.payload.text,
        systemPrompt: input.payload.systemPrompt,
        model: input.expected.selection.model,
        reasoningEffort: input.expected.selection.thinking,
        agentProfile,
        ...('kind' in input.workspace && input.workspace.kind === 'ordinary'
          ? { ordinaryWorkspace: input.workspace }
          : { repositoryWorkspace: input.workspace }),
      });
      native.setArtifactRuntime('session', account, artifact);
      input.admission.adoptPhysicalRuntime(artifact);
      input.admission.persistNativeCustody(native);
      native.bindThread('session', account, 'native-thread');
      opened = true;
    }
    input.assertCredentialSetupCurrent?.();
    input.admission.assertBeforeEnqueue({
      id: input.commandId,
      prompt: assembleSourceSnapshots(input.payload.text, input.payload.sourceSnapshots),
      intent: input.payload.intent ?? input.payload.text,
      model: input.expected.selection.model,
      reasoningEffort: input.expected.selection.thinking,
    });
    native.enqueue('session', account, {
      id: input.commandId,
      prompt: assembleSourceSnapshots(input.payload.text, input.payload.sourceSnapshots),
      intent: input.payload.intent ?? input.payload.text,
      model: input.expected.selection.model,
      reasoningEffort: input.expected.selection.thinking,
    });
    if (!input.assertCredentialSetupCurrent) pump();
  });
  const assertCurrentSync = vi.fn();
  const assertCurrent = vi.fn(async () => {});
  const close = vi.fn();
  const owners = {
    enabled: true,
    nativeStore: native,
    authSessionId: 'signed-operator',
    events,
    profiles,
    workspaceKind: ordinary ? ('ordinary' as const) : ('repository' as const),
    workspace: { claim, claimOrdinaryWorkspace } as unknown as RepositoryWorkspaces,
    sessionId: 'session',
    workspaceId,
    taskRoot: '/fixture/root',
    config,
    target,
    projection,
    capabilitiesCurrent: () => ({ profiles, projection }),
    account,
    assertCurrentSync,
    assertCurrentIdentitySync: assertCurrentSync,
    assertCurrent,
    readRetained: () => native.readArtifactRuntime('session', account) ?? undefined,
    assertRetainedAuthority: vi.fn(),
    dispatch,
    dispatchContinuation: dispatch,
    signal: new AbortController().signal,
    close,
  };
  const driver = new OrdinaryOpenShellCodexOwnedRuntime(owners);
  return {
    native,
    claimOrdinaryWorkspace,
    preparationOperationId,
    workspaceId,
    pump,
    owners,
    reopen: () => {
      native.close();
      natives.splice(natives.indexOf(native), 1);
      native = new CodexConversationStore(join(root, 'native.db'));
      natives.push(native);
      owners.nativeStore = native;
      return native;
    },
    driver,
    events,
    account,
    meta,
    command,
    claim,
    dispatch,
    assertCurrent,
    assertCurrentSync,
  };
}
describe('bound ordinary OpenShell owner (offline)', () => {
  it('claims existing sandbox metadata before uncertain provider dispatch and freezes future command settings', async () => {
    const f = fixture();
    await expect(f.driver.admit(f.meta, f.command('first'))).resolves.toMatchObject({
      dispatched: true,
    });
    expect(f.claim.mock.invocationCallOrder[0]).toBeLessThan(
      f.dispatch.mock.invocationCallOrder[0],
    );
    expect(f.claim).toHaveBeenCalledWith('repo', f.account, 'session', '/fixture/root', true);
    const original = f.events.getSession('session');
    await f.driver.admit(
      {
        ...f.meta,
        accountBinding: { ...f.account, model: 'next' },
        selectedModel: 'next',
        reasoningEffort: 'high',
      },
      f.command('next', 'next', 'high'),
    );
    expect(f.events.getSession('session')).toEqual(original);
    expect(f.events.getOrdinaryOpenShellCommandAdmission('first')?.selection.model).toBe('first');
    expect(f.events.getOrdinaryOpenShellCommandAdmission('next')?.selection.model).toBe('next');
    expect(f.dispatch.mock.calls[1][0].account.model).toBe('first');
    await expect(f.driver.admit(f.meta, f.command('first'))).resolves.toMatchObject({
      dispatched: false,
    });
    expect(f.dispatch).toHaveBeenCalledTimes(2);
  });
  it('reopens exact native custody and accepts a new explicit command without replaying old turns', async () => {
    const f = fixture();
    await f.driver.admit(f.meta, f.command('first'));
    await f.driver.admit(
      { ...f.meta, selectedModel: 'next', reasoningEffort: 'high' },
      f.command('second', 'next', 'high'),
    );
    const before = f.native.commands('session', f.account);
    const physical = f.native.readArtifactRuntime('session', f.account);
    f.driver.close();
    const reopened = f.reopen();
    const resumeDispatch = vi.fn(async (input) => {
      input.admission.assertOptions({
        conversationId: 'session',
        messageId: input.commandId,
        resume: true,
        binding: input.account,
        profile: input.profile,
        session: { cwd: f.meta.cwd, mode: 'agent' },
        prompt: input.payload.text,
        systemPrompt: input.payload.systemPrompt,
        model: input.expected.selection.model,
        reasoningEffort: input.expected.selection.thinking,
        agentProfile: f.meta.agentProfile,
        ...('kind' in input.workspace && input.workspace.kind === 'ordinary'
          ? { ordinaryWorkspace: input.workspace }
          : { repositoryWorkspace: input.workspace }),
      });
      input.admission.persistNativeCustody(reopened);
      await f.dispatch(input);
    });
    const resumed = new OrdinaryOpenShellCodexOwnedRuntime({
      ...f.owners,
      resume: true,
      dispatch: resumeDispatch,
    });
    await expect(resumed.admit(f.meta, f.command('after-restart'))).resolves.toMatchObject({
      dispatched: true,
    });
    await resumed.admit(
      { ...f.meta, selectedModel: 'next', reasoningEffort: 'high' },
      f.command('followup', 'next', 'high'),
    );
    expect(reopened.commands('session', f.account)[0]).toEqual(before[0]);
    expect(
      reopened
        .commands('session', f.account)
        .slice(0, 2)
        .map((command) => ({ id: command.id, model: command.model, prompt: command.prompt })),
    ).toEqual(
      before.map((command) => ({ id: command.id, model: command.model, prompt: command.prompt })),
    );
    expect(reopened.readArtifactRuntime('session', f.account)).toEqual(physical);
    expect(reopened.read('session', f.account).threadId).toBe('native-thread');
    expect(resumeDispatch).toHaveBeenCalledTimes(1);
  });
  it('refuses a different signed operator on cold resume', async () => {
    const f = fixture();
    await f.driver.admit(f.meta, f.command('first'));
    f.driver.close();
    f.reopen();
    const resumed = new OrdinaryOpenShellCodexOwnedRuntime({
      ...f.owners,
      resume: true,
      authSessionId: 'another-operator',
    });
    await expect(resumed.admit(f.meta, f.command('after-restart'))).rejects.toThrow();
    expect(f.events.getOrdinaryOpenShellCommandAdmission('after-restart')).toBeUndefined();
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });
  it('keeps independent sessions physical resources and histories separate', async () => {
    const first = fixture(),
      second = fixture();
    await first.driver.admit(first.meta, first.command('first'));
    await second.driver.admit(second.meta, second.command('other'));
    expect(first.native.readArtifactRuntime('session', first.account)?.runtime.sandboxId).not.toBe(
      second.native.readArtifactRuntime('session', second.account)?.runtime.sandboxId,
    );
    expect(first.native.commands('session', first.account).map((command) => command.id)).toEqual([
      'first',
    ]);
    expect(second.native.commands('session', second.account).map((command) => command.id)).toEqual([
      'other',
    ]);
  });
  it('accepts a newly supported future model after removing only a completed historical model', async () => {
    const f = fixture();
    await f.driver.admit(f.meta, f.command('first'));
    const profiles = new AccountProfiles(
      [
        {
          id: 'personal',
          label: 'Personal',
          provider: 'openai-codex',
          email: 'fixture@example.test',
          planType: 'plus',
          sandboxProvider: 'provider',
          sandboxProviderType: 'openai-codex-oauth',
          sandboxProviderId: 'provider-id',
          sandboxGrantId: 'grant-id',
          models: [{ id: 'fresh-model', label: 'Fresh', reasoningEfforts: ['high'] }],
        },
      ],
      { codexEnabled: true },
    );
    const projection = projectOrdinaryOpenShellCodexCapabilities({
      profiles,
      target: f.owners.target,
      deployment: 'ordinary',
    });
    expect(profiles.resolve('personal', 'fresh-model').profileRevision).toBe(
      f.account.profileRevision,
    );
    f.owners.capabilitiesCurrent = () => ({ profiles, projection });
    const command = {
      ...f.command('fresh', 'fresh-model', 'high'),
      capabilityRevision: projection.inventory.capabilityRevision,
    };
    await expect(
      f.driver.admit({ ...f.meta, selectedModel: 'fresh-model', reasoningEffort: 'high' }, command),
    ).resolves.toMatchObject({ dispatched: true });
    f.pump();
    expect(f.native.commands('session', f.account).map((command) => command.model)).toEqual([
      'first',
      'fresh-model',
    ]);
    expect(f.native.read('session', f.account).threadId).toBe('native-thread');
  });
  it('retains uncertainty after a failed effect and refuses automatic replay', async () => {
    const f = fixture();
    f.dispatch.mockRejectedValueOnce(new Error('uncertain launch'));
    await expect(f.driver.admit(f.meta, f.command('first'))).rejects.toThrow();
    expect(f.events.getOrdinaryOpenShellCommandAdmission('first')?.state).toBe('uncertain');
    await expect(f.driver.admit(f.meta, f.command('first'))).resolves.toMatchObject({
      dispatched: false,
    });
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });
  it('rejects fresh authority revocation before claiming provider effects', async () => {
    const f = fixture();
    f.assertCurrent
      .mockImplementationOnce(async () => {})
      .mockRejectedValueOnce(new Error('revoked'));
    await expect(f.driver.admit(f.meta, f.command('first'))).rejects.toThrow('revoked');
    expect(f.events.getOrdinaryOpenShellCommandAdmission('first')?.state).toBe('reserved');
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it.each(['target', 'capability', 'thinking', 'agent'])(
    'rejects %s drift before metadata claim',
    async (kind) => {
      const f = fixture();
      const request = f.command('first');
      if (kind === 'target') request.runtime.targetId = 'other';
      if (kind === 'capability') request.capabilityRevision = 'other';
      if (kind === 'thinking') request.selection.thinking = 'unsupported';
      if (kind === 'agent') request.selection.agent.revision = 2;
      await expect(f.driver.admit(f.meta, request)).rejects.toThrow();
      expect(f.claim).not.toHaveBeenCalled();
      expect(f.dispatch).not.toHaveBeenCalled();
    },
  );
});

it('refuses an expired incoming warm authority wait without changing the original queue or owner', async () => {
  const f = fixture();
  await f.driver.admit(f.meta, f.command('first'));
  const queued = f.native.commands('session', f.account);
  let waiting = false,
    release!: () => void;
  const deferred = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.assertCurrent.mockImplementation(async () => {
    waiting = true;
    await deferred;
  });
  const controller = new AbortController();
  const next = f.command('expired', 'next', 'high');
  const nextMeta = { ...f.meta, selectedModel: 'next', reasoningEffort: 'high' };
  const pending = f.driver.admit(nextMeta, next, controller.signal).then(
    () => 'accepted',
    () => 'refused',
  );
  await vi.waitFor(() => expect(waiting).toBe(true));
  controller.abort(new Error('Incoming preparation deadline'));
  release();
  expect(await pending).toBe('refused');
  expect(f.events.getSendCommand('expired')).toBeUndefined();
  expect(f.native.commands('session', f.account)).toEqual(queued);
  expect(f.dispatch).toHaveBeenCalledOnce();
  f.assertCurrent.mockImplementation(async () => {});
  await expect(
    f.driver.admit(nextMeta, f.command('accepted-next', 'next', 'high')),
  ).resolves.toMatchObject({ dispatched: true });
  expect(f.dispatch).toHaveBeenCalledTimes(2);
});

it('acknowledges a retained consumed OpenShell command after catalog retirement without native effects', async () => {
  const f = fixture();
  const { buildAgentProfilePrompt } = await import('../agent-library-prompt.js');
  const first = f.command('first');
  first.payload.systemPrompt = buildAgentProfilePrompt(f.meta.agentProfile.definition);
  const later = f.command('later', 'next', 'high');
  later.payload.systemPrompt = first.payload.systemPrompt;
  await f.driver.admit(f.meta, first);
  await f.driver.admit(
    {
      ...f.meta,
      selectedModel: 'next',
      reasoningEffort: 'high',
      accountBinding: { ...f.account, model: 'next' },
    },
    later,
  );
  vi.spyOn(await import('../codex-chat-session.js'), 'getCodexConversationStore').mockReturnValue(
    f.native,
  );
  const retiredProfiles = new AccountProfiles(
    [
      {
        id: 'personal',
        label: 'Refreshed label',
        provider: 'openai-codex',
        email: 'fixture@example.test',
        planType: 'plus',
        sandboxProvider: 'provider',
        sandboxProviderType: 'openai-codex-oauth',
        sandboxProviderId: 'provider-id',
        sandboxGrantId: 'grant-id',
        models: [{ id: 'future-C', label: 'Current C' }],
      },
    ],
    { codexEnabled: true },
  );
  vi.spyOn(await import('../account-profiles.js'), 'loadAccountProfiles').mockReturnValue(
    retiredProfiles,
  );
  const { assertOrdinaryHistoricalAcknowledgement } =
    await import('../ordinary-command-historical-ack.js');
  const { OrdinaryCodexContinuationCommandSchema } = await import('@mitzo/protocol');
  const wire = OrdinaryCodexContinuationCommandSchema.parse({
    ...later,
    runtime: { ...later.runtime, account: { ...later.runtime.account, provider: 'openai-codex' } },
    payload: { text: later.payload.text },
    runOn: 'openshell',
    repositoryWorkspaceId: '00000000-0000-4000-8000-000000000001',
    sessionId: 'session',
  });
  wire.repositoryWorkspaceId = 'repo';
  expect(f.events.getSession('session')?.agentProfile).toEqual(f.meta.agentProfile);
  const receipt = f.events.getOrdinaryOpenShellCommandAdmission('later');
  const history = f.native.commands('session', f.account);
  const artifact = f.native.readArtifactRuntime('session', f.account);
  const calls = f.dispatch.mock.calls.length;
  const claims = f.claim.mock.calls.length;
  expect(
    assertOrdinaryHistoricalAcknowledgement(f.events, 'session', 'signed-operator', wire, false),
  ).toBe(true);
  expect(() =>
    assertOrdinaryHistoricalAcknowledgement(f.events, 'session', 'foreign-operator', wire, false),
  ).toThrow();
  expect(() =>
    assertOrdinaryHistoricalAcknowledgement(
      f.events,
      'session',
      'signed-operator',
      { ...wire, payload: { text: 'Different' } },
      false,
    ),
  ).toThrow();
  expect(() =>
    assertOrdinaryHistoricalAcknowledgement(
      f.events,
      'session',
      'signed-operator',
      { ...wire, selection: { ...wire.selection, thinking: 'low' } },
      false,
    ),
  ).toThrow();
  expect(f.events.getOrdinaryOpenShellCommandAdmission('later')).toEqual(receipt);
  expect(f.native.commands('session', f.account)).toEqual(history);
  expect(f.native.readArtifactRuntime('session', f.account)).toEqual(artifact);
  expect(f.dispatch).toHaveBeenCalledTimes(calls);
  expect(f.claim).toHaveBeenCalledTimes(claims);
  vi.restoreAllMocks();
});

it('admits the first explicit OpenShell prompt from a silent allocation without adopting continuation', async () => {
  const f = fixture();
  const command = f.command('first');
  const binding = {
    version: 2 as const,
    account: command.runtime.account,
    harness: { implementation: 'codex' as const },
    execution: {
      location: 'openshell' as const,
      targetId: f.owners.target.targetId,
      targetRevision: f.owners.target.targetRevision,
    },
  };
  f.events.prepareOrdinarySession(f.meta, {
    allocationOperationId: 'allocation',
    preparationFingerprint: 'a'.repeat(64),
    settings: CollaborationSettingsSchema.parse({
      binding,
      selection: command.selection,
      repositoryWorkspaceId: 'repo',
    }),
  });
  expect(f.dispatch).not.toHaveBeenCalled();
  await expect(f.driver.admitPreparedFirst('allocation', f.meta, command)).resolves.toMatchObject({
    dispatched: true,
  });
  expect(f.dispatch).toHaveBeenCalledOnce();
  expect(f.events.getOrdinarySessionPreparation('allocation')?.firstCommandId).toBe('first');
  await expect(f.driver.admitPreparedFirst('allocation', f.meta, command)).resolves.toMatchObject({
    dispatched: false,
  });
  expect(f.dispatch).toHaveBeenCalledOnce();
});

it('keeps prepared-first retries bound after OpenShell origin is installed', async () => {
  const f = fixture();
  const command = f.command('first');
  const binding = {
    version: 2 as const,
    account: command.runtime.account,
    harness: { implementation: 'codex' as const },
    execution: {
      location: 'openshell' as const,
      targetId: f.owners.target.targetId,
      targetRevision: f.owners.target.targetRevision,
    },
  };
  f.events.prepareOrdinarySession(f.meta, {
    allocationOperationId: 'allocation',
    preparationFingerprint: 'a'.repeat(64),
    settings: CollaborationSettingsSchema.parse({
      binding,
      selection: command.selection,
      repositoryWorkspaceId: 'repo',
    }),
  });
  await f.driver.admitPreparedFirst('allocation', f.meta, command);
  await expect(f.driver.admitPreparedFirst('other-operation', f.meta, command)).rejects.toThrow();
  await expect(
    f.driver.admitPreparedFirst('allocation', f.meta, f.command('other-command')),
  ).rejects.toThrow();
  expect(f.dispatch).toHaveBeenCalledOnce();
  expect(f.events.getSendCommand('other-command')).toBeUndefined();
});

it('delivers reviewed Library context through the ordinary OpenShell owner without rewriting visible input or duplicating a retry', async () => {
  const f = fixture();
  const raw = f.command('library-first');
  const content = JSON.stringify({
    version: 1,
    source: {
      kind: 'draft',
      profileId: 'editing-agent',
      baseRevision: 3,
      draftVersion: null,
      expectedVersion: 2,
    },
    definition: {
      ...f.meta.agentProfile.definition,
      instructions: 'Preserve this exact unsaved instruction.',
    },
  });
  const source = {
    kind: 'agent-library' as const,
    revision: contextDigest(JSON.parse(content)),
    content,
  };
  const request = { ...raw, payload: { ...raw.payload, sourceSnapshots: [source] } };
  await expect(f.driver.admit(f.meta, request)).resolves.toMatchObject({ dispatched: true });
  expect(f.events.getSendCommand(raw.clientMsgId)?.payload).toMatchObject({
    text: raw.payload.text,
    sourceSnapshots: [source],
  });
  const native = f.native.commands('session', f.account);
  expect(native).toHaveLength(1);
  expect(native[0].prompt).toBe(assembleSourceSnapshots(raw.payload.text, [source]));
  expect(native[0].prompt).toContain('Preserve this exact unsaved instruction.');
  expect(f.dispatch.mock.calls[0][0].payload.text).toBe(raw.payload.text);
  await expect(f.driver.admit(f.meta, request)).resolves.toMatchObject({ dispatched: false });
  expect(f.native.commands('session', f.account)).toEqual(native);
  expect(f.dispatch).toHaveBeenCalledOnce();
  const changed = JSON.stringify({ ...JSON.parse(content), reviewedContext: 'Changed review' });
  await expect(
    f.driver.admit(f.meta, {
      ...request,
      payload: {
        ...request.payload,
        sourceSnapshots: [
          { ...source, content: changed, revision: contextDigest(JSON.parse(changed)) },
        ],
      },
    }),
  ).rejects.toThrow();
  expect(f.native.commands('session', f.account)).toEqual(native);
  expect(f.dispatch).toHaveBeenCalledOnce();
});

it('rejects changed Library source bytes before claiming the ordinary OpenShell workspace or dispatching', async () => {
  const f = fixture();
  const content = JSON.stringify({
    version: 1,
    source: {
      kind: 'draft',
      profileId: 'editing-agent',
      baseRevision: 0,
      draftVersion: null,
      expectedVersion: 0,
    },
    definition: f.meta.agentProfile.definition,
  });
  const request = f.command('invalid-library');
  await expect(
    f.driver.admit(f.meta, {
      ...request,
      payload: {
        ...request.payload,
        sourceSnapshots: [{ kind: 'agent-library', revision: 'a'.repeat(64), content }],
      },
    }),
  ).rejects.toThrow();
  expect(f.claim).not.toHaveBeenCalled();
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(f.events.getSendCommand(request.clientMsgId)).toBeUndefined();
});

it('uses the ordinary default OpenShell workspace through first send, continuation and native restart without a repository claim', async () => {
  const f = fixture(true);
  const first = await f.driver.admitPreparedFirst(
    f.preparationOperationId!,
    f.meta,
    f.command('default-first'),
  );
  expect(first.dispatched).toBe(true);
  f.pump();
  expect(f.events.getSession('session')?.ordinaryWorkspaceId).toBe(f.workspaceId);
  expect(f.events.getSession('session')?.repositoryWorkspaceId ?? null).toBeNull();
  expect(f.claim).not.toHaveBeenCalled();
  expect(f.claimOrdinaryWorkspace).toHaveBeenCalledOnce();
  expect(f.native.readOpenShellCustody('session', f.account)?.workspaceKind).toBe('ordinary');
  const nextMeta = { ...f.meta, selectedModel: 'next', reasoningEffort: 'high' };
  expect(
    (await f.driver.admit(nextMeta, f.command('default-next', 'next', 'high'))).dispatched,
  ).toBe(true);
  f.pump();
  const reopened = f.reopen();
  const resumed = new OrdinaryOpenShellCodexOwnedRuntime({
    ...f.owners,
    nativeStore: reopened,
    resume: true,
  });
  expect(
    (await resumed.admit(nextMeta, f.command('default-restarted', 'next', 'high'))).dispatched,
  ).toBe(true);
  f.pump();
  expect(reopened.commands('session', f.account).map((command) => command.status)).toEqual([
    'completed',
    'completed',
    'completed',
  ]);
  expect(f.claim).not.toHaveBeenCalled();
});

it('delivers real App private relay and MFA readiness through guarded runtime-bound native admission', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mitzo-private-readiness-app-'));
  roots.push(directory);
  vi.stubEnv('REPO_PATH', directory);
  vi.stubEnv('MITZO_KEYCHAIN_CONNECTIONS_ENABLED', '');
  const engine = await import('../app.js');
  const chat = await import('../chat.js');
  const codex = await import('../codex-chat-session.js');
  const { default: request } = await import('supertest');
  const { CredentialConnectionStore, CredentialConnections } =
    await import('../credential-connections.js');
  const { SecretRelays } = await import('../secret-relay.js');
  const { PrivateRelayBrowsers } = await import('../secret-relay-browser.js');
  const { buildAgentProfilePrompt } = await import('../agent-library-prompt.js');
  const f = fixture(false, chat.eventStore);
  const first = f.command('first');
  first.payload.systemPrompt = buildAgentProfilePrompt(f.meta.agentProfile.definition);
  await f.driver.admit(f.meta, first);
  f.pump();
  const queue = { push: vi.fn(), close: vi.fn() };
  chat.registry.register('private-origin', {
    sessionId: 'session',
    mode: 'agent',
    cwd: f.meta.cwd,
    accountBinding: f.account,
    transport: { send: vi.fn(), isOpen: () => true },
    inputQueue: queue,
    abortController: new AbortController(),
    sessionAllowList: new Set(),
  });
  const session = chat.registry.get('private-origin')!;
  const owner = {
    location: 'openshell' as const,
    authSessionId: 'signed-operator',
    identity: f.driver,
    initialCommandId: 'first',
    admit: async () => ({ dispatched: false }),
    retryInitial: async () => ({ dispatched: false }),
    close: () => {},
    notifyCredentialSetup: (
      notice: import('../credential-setup-continuation.js').CredentialSetupNotification,
    ) => f.driver.notifyCredentialSetup(chat.eventStore.getSession('session')!, notice),
  };
  session.ordinaryRuntimeOwner = owner;
  let paused = false;
  const native = {
    queue: () => f.native.commands('session', f.account),
    isPaused: () => paused,
    isRecovering: () => false,
    startQueued: vi.fn(async () => f.pump()),
  };
  const runtime = vi
    .spyOn(codex, 'getCodexRuntime')
    .mockImplementation((current) => (current === session ? (native as never) : undefined));
  const store = new CredentialConnectionStore(':memory:');
  const browser = new PrivateRelayBrowsers(async () => ({
    login: async () => ({ challenge: true }),
    code: async () => {},
    action: async () => {},
    close: async () => {},
  }));
  const vault = {
    save: vi.fn(async () => ({
      gateway: 'fixture',
      workspace: 'fixture',
      name: 'private',
      providerId: '1',
      version: '1',
      profileVersion: '1',
    })),
    read: vi.fn(async () => 'private-password'),
  };
  const service = new CredentialConnections(store, {} as never, vi.fn());
  service.relay = new SecretRelays(
    store,
    vault,
    () => {
      throw Error('No public HTTP');
    },
    vi.fn(),
    false,
    { browser },
  );
  engine.setCredentialConnectionsRuntime(service);
  const prepare = () =>
    service.relay!.prepare('session', {
      label: 'private-service-label',
      targets: [
        {
          adapter: 'browser',
          origin: 'https://service.example',
          requests: [
            { path: '/login', methods: ['GET', 'POST'] },
            { path: '/whoami', methods: ['GET'] },
          ],
          login: { path: '/login', passwordSelector: '#password', submitSelector: '#login' },
          mfa: { codeSelector: '#code', submitSelector: '#verify' },
          verification: { path: '/whoami', pointer: '/authenticated', equals: true },
        },
      ],
    });
  try {
    const agent = request.agent(engine.app);
    await agent
      .post('/api/auth/login')
      .send({ passphrase: 'test-passphrase-for-vitest' })
      .expect(200);
    const auth = await agent
      .post('/api/credential-connections/reauthorize')
      .send({ passphrase: 'test-passphrase-for-vitest' })
      .expect(200);
    const complete = (draft: ReturnType<typeof prepare>) =>
      agent
        .post(`/api/credential-connections/relays/${draft.id}/complete`)
        .set('x-csrf-token', auth.body.csrf)
        .send({ revision: draft.revision, secret: 'private-password' });
    const draft = prepare();
    await expect(chat.sendToChat('private-origin', 'must remain forbidden')).rejects.toThrow(
      'guarded admission',
    );
    const response = await complete(draft).expect(200);
    expect(response.body.relay.delivery).toBe('delivered');
    const firstId = `secret-relay:${draft.id}`;
    expect(f.native.commands('session', f.account).filter((c) => c.id === firstId)).toHaveLength(1);
    await service.relay.apply('session', draft.id, 0, new AbortController().signal, () => true);
    const challenge = service.relay.browserStatus(draft.id);
    const code = await agent
      .post(`/api/credential-connections/relays/${draft.id}/code`)
      .set('x-csrf-token', auth.body.csrf)
      .send({ revision: challenge.revision, targetIndex: 0, code: '123456' })
      .expect(200);
    expect(code.body.relay.delivery).toBe('delivered');
    const codeId = `${firstId}:1`;
    expect(f.native.commands('session', f.account).filter((c) => c.id === codeId)).toHaveLength(1);
    engine.setCredentialConnectionsRuntime(service);
    await new Promise((done) => setTimeout(done, 0));
    const notices = f.native
      .commands('session', f.account)
      .filter((c) => c.id.startsWith('secret-relay:'));
    expect(notices).toHaveLength(2);
    expect(native.startQueued).toHaveBeenCalledTimes(2);
    expect(notices.every((notice) => notice.status === 'completed')).toBe(true);
    expect(JSON.stringify(notices)).not.toMatch(/private-password|123456|private-service-label/);
    expect(queue.push).not.toHaveBeenCalled();
    paused = true;
    const pausedDraft = prepare();
    const pausedResponse = await complete(pausedDraft).expect(200);
    expect(pausedResponse.body.relay.delivery).toBe('pending');
    expect(native.startQueued).toHaveBeenCalledTimes(2);
    expect(
      f.native.commands('session', f.account).filter((c) => c.id.startsWith('secret-relay:')),
    ).toHaveLength(2);
    service.relay.cancel(pausedDraft.id, pausedResponse.body.relay.revision);
    paused = false;
    const unsupported = prepare();
    delete (session.ordinaryRuntimeOwner as Partial<typeof owner>).notifyCredentialSetup;
    await complete(unsupported).expect(409);
    expect(vault.save).toHaveBeenCalledTimes(2);
    session.ordinaryRuntimeOwner = {
      ...owner,
      notifyCredentialSetup: (notice) =>
        f.driver.notifyCredentialSetup(chat.eventStore.getSession('session')!, notice),
    };
    const revoked = prepare();
    f.assertCurrent.mockImplementationOnce(async () => {
      service.relay!.cancel(revoked.id, service.relay!.browserStatus(revoked.id).revision);
    });
    const refused = await complete(revoked).expect(200);
    expect(refused.body.relay.status).toBe('cancelled');
    expect(
      f.native.commands('session', f.account).filter((c) => c.id.startsWith('secret-relay:')),
    ).toHaveLength(2);
    expect(
      chat.eventStore.getOrdinaryOpenShellCommandAdmission(`secret-relay:${revoked.id}`),
    ).toBeUndefined();
  } finally {
    engine.setCredentialConnectionsRuntime(null);
    chat.registry.abort('private-origin');
    runtime.mockRestore();
    await browser.dispose();
    store.close();
    engine.taskStore.close();
    vi.unstubAllEnvs();
  }
});
