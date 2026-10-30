import { AgentLibraryVersionSchema, OrdinaryWorkspaceSettingsSchema } from '@mitzo/protocol';
import { contextDigest } from '../../agent-context-compiler.js';
import { assembleSourceSnapshots } from '../../source-snapshot-context.js';
import { expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { CodexConversationStore } from '../../codex-conversation-store.js';
import { EventStore } from '../../event-store.js';
import { AccountProfiles } from '../../account-profiles.js';
import type { RepositoryWorkspaces } from '../../repository-workspaces.js';
import type { OpenShellRuntimeConfig } from '../../openshell-runtime.js';
import {
  ordinaryOpenShellCodexTarget,
  projectOrdinaryOpenShellCodexCapabilities,
} from '../../ordinary-openshell-codex-route.js';
import { OrdinaryOpenShellCodexOwnedRuntime } from '../../ordinary-openshell-codex-owned-runtime.js';

export function ownedOpenShellFixture(
  resources: { stores: EventStore[]; natives: CodexConversationStore[]; roots: string[] },
  ordinary = false,
  existingEvents?: EventStore,
  legacyRevision?: string,
  options: { api?: boolean; nativeStore?: CodexConversationStore } = {},
) {
  const { stores, natives, roots } = resources;
  const workspaceId = ordinary ? randomUUID() : 'repo';
  const events = existingEvents ?? new EventStore(':memory:');
  stores.push(events);
  const profiles = new AccountProfiles(
    [
      options.api
        ? {
            id: 'personal',
            label: 'API',
            provider: 'openai',
            credentialRef: { provider: 'keychain', service: 'offline', account: 'api' },
            sandboxProvider: 'provider',
            sandboxProviderId: 'provider-id',
            models: [
              { id: 'first', label: 'First', reasoningEfforts: ['low'] },
              { id: 'next', label: 'Next', reasoningEfforts: ['high'] },
            ],
          }
        : {
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
  let native = options.nativeStore ?? new CodexConversationStore(join(root, 'native.db'));
  if (!options.nativeStore) natives.push(native);
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
    openaiApi: options.api ? 'enabled' : 'disabled',
  });
  if (legacyRevision) target.targetRevision = legacyRevision;
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
    route: options.api
      ? { kind: 'api' as const, provider: 'provider', model: 'first' }
      : {
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
    | import('../../owned-openshell-codex-chat-admission.js').OwnedOpenShellCodexChatAdmission
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
    root,
    artifact,
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
