import { contextDigest } from '../agent-context-compiler.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
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

const stores: EventStore[] = [];
const natives: CodexConversationStore[] = [];
const roots: string[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  natives.splice(0).forEach((store) => store.close());
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
function fixture() {
  const events = new EventStore(':memory:');
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
  const agentProfile = {
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
  };
  agentProfile.contentHash = contextDigest(agentProfile.definition);
  const meta = {
    sessionId: 'session',
    repositoryWorkspaceId: 'repo',
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
        prompt: input.payload.text,
        systemPrompt: input.payload.systemPrompt,
        model: input.expected.selection.model,
        reasoningEffort: input.expected.selection.thinking,
        agentProfile,
        repositoryWorkspace: input.workspace,
      });
      native.setArtifactRuntime('session', account, artifact);
      input.admission.adoptPhysicalRuntime(artifact);
      input.admission.persistNativeCustody(native);
      native.bindThread('session', account, 'native-thread');
      opened = true;
    }
    input.admission.assertBeforeEnqueue({
      id: input.commandId,
      prompt: input.payload.text,
      model: input.expected.selection.model,
      reasoningEffort: input.expected.selection.thinking,
    });
    native.enqueue('session', account, {
      id: input.commandId,
      prompt: input.payload.text,
      model: input.expected.selection.model,
      reasoningEffort: input.expected.selection.thinking,
    });
    pump();
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
    workspace: { claim } as unknown as RepositoryWorkspaces,
    sessionId: 'session',
    workspaceId: 'repo',
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
        repositoryWorkspace: input.workspace,
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
