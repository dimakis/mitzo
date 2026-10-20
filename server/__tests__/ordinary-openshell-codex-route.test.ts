import { describe, expect, it } from 'vitest';
import { AccountProfiles } from '../account-profiles.js';
import type { OpenShellRuntimeConfig } from '../openshell-runtime.js';
import type { ArtifactRuntime } from '../codex-conversation-store.js';
import {
  assertOrdinaryOpenShellCodexRoute,
  ordinaryOpenShellCodexTarget,
  projectOrdinaryOpenShellCodexCapabilities,
} from '../ordinary-openshell-codex-route.js';

const config = {
  cli: '/fixture/openshell',
  image: 'fixture-image',
  policy: '/fixture/policy',
  seed: '/fixture/seed',
  workspace: 'fixture-workspace',
  gateway: 'fixture-gateway',
  gatewayInsecure: false,
  workdir: '/sandbox/workspaces/task',
  serviceProviders: [],
  grantableServiceProviders: [],
  createDetached: true,
  sandboxIdLength: 24,
  webSearch: 'disabled',
} satisfies OpenShellRuntimeConfig;
function fixture(provider: 'openai-codex' | 'openai' = 'openai-codex') {
  const profiles = new AccountProfiles(
    [
      provider === 'openai-codex'
        ? {
            id: 'account',
            label: 'Account',
            provider,
            email: 'fixture@example.test',
            planType: 'plus',
            sandboxProvider: 'provider',
            sandboxProviderType: 'openai-codex-oauth',
            sandboxProviderId: 'provider-id',
            sandboxGrantId: 'grant-id',
            models: [{ id: 'fixture-model', label: 'Fixture', reasoningEfforts: ['low'] }],
          }
        : {
            id: 'account',
            label: 'Account',
            provider,
            credentialRef: { provider: 'fixture', service: 'fixture', account: 'fixture' },
            sandboxProvider: 'provider',
            sandboxProviderId: 'provider-id',
            models: [{ id: 'fixture-model', label: 'Fixture', reasoningEfforts: ['low'] }],
          },
    ],
    { codexEnabled: true },
  );
  const account = profiles.resolve('account', 'fixture-model');
  const target = ordinaryOpenShellCodexTarget({
    targetId: 'target',
    runtimeContractRevision: 'contract-r1',
    config,
    openaiApi: 'enabled',
  });
  return {
    account,
    profiles,
    target,
    model: 'fixture-model',
    mode: 'agent' as const,
    binding: {
      version: 2,
      account: { accountId: account.accountId, provider, profileRevision: account.profileRevision },
      harness: { implementation: 'codex' },
      execution: {
        location: 'openshell',
        targetId: target.targetId,
        targetRevision: target.targetRevision,
      },
    },
    catalog: {
      deployment: 'ordinary' as const,
      enabledHarnesses: ['codex' as const],
      targets: [target],
      accounts: [
        provider === 'openai-codex'
          ? {
              accountId: account.accountId,
              provider,
              profileRevision: account.profileRevision,
              planType: 'plus',
              auth: { kind: 'brokered-oauth' as const, targetIds: ['target'] },
            }
          : {
              accountId: account.accountId,
              provider,
              profileRevision: account.profileRevision,
              auth: { kind: 'api-credential' as const, openshellTargetIds: ['target'] },
            },
      ],
    },
  };
}
function retained(route: ReturnType<typeof assertOrdinaryOpenShellCodexRoute>): ArtifactRuntime {
  return {
    route,
    runtime: {
      sandboxName: 'retained',
      sandboxId: 'physical-id',
      workdir: config.workdir,
      appServerCommand: '/sandbox/run-mitzo-subscription-app-server',
      cli: config.cli,
      gateway: config.gateway,
      workspace: config.workspace,
      gatewayInsecure: false,
    },
  };
}
describe('ordinary OpenShell configuration adoption (offline)', () => {
  it('keeps an existing pinned API account selectable without a new enrollment', () => {
    const input = fixture('openai');
    expect(input.profiles.isEnrolledOpenAIAccount('account')).toBe(false);
    const result = projectOrdinaryOpenShellCodexCapabilities({
      profiles: input.profiles,
      target: input.target,
      deployment: 'ordinary',
    });
    expect(result.inventory.accounts.map(({ account }) => account.accountId)).toEqual(['account']);
    expect(result.inventory.routes[0]).toMatchObject({ harness: 'codex', targetId: 'target' });
    expect(JSON.stringify(result.inventory)).not.toMatch(/credentialRef|provider-id/);
    expect(input.profiles.ordinaryOpenShellCodexInventory('target', false)).toEqual([]);
  });
  it('keeps an API account without a pinned sandbox identity available only locally', () => {
    const profiles = new AccountProfiles([
      {
        id: 'work',
        label: 'Work',
        provider: 'openai',
        credentialRef: { provider: 'fixture', service: 'fixture', account: 'fixture' },
        sandboxProvider: 'provider',
        models: [{ id: 'fixture-model', label: 'Fixture' }],
      },
    ]);
    expect(profiles.ordinaryOpenShellCodexInventory('target', true)).toEqual([]);
    expect(profiles.ordinaryLocalResponsesInventory()).toHaveLength(1);
  });
  it('projects existing account metadata without claiming readiness or exposing auth', () => {
    const input = fixture();
    const result = projectOrdinaryOpenShellCodexCapabilities({
      profiles: input.profiles,
      target: input.target,
      deployment: 'ordinary',
    });
    expect(result.inventory.defaultLocation).toBe('openshell');
    expect(result.inventory.locations[0]).toMatchObject({
      status: 'unavailable',
      reason: 'openshell_admission_pending',
    });
    expect(result.inventory.routes[0].modes).toEqual(['agent', 'auto']);
    expect(result.catalog.accounts[0]).toMatchObject({
      auth: { kind: 'brokered-oauth', targetIds: ['target'] },
    });
    expect(JSON.stringify(result.inventory)).not.toContain('grant-id');
    expect(result.inventory.accounts[0].account).not.toHaveProperty('auth');
  });
  it('keeps capability identity stable across presentation/cache timestamps and changes it for thinking support', () => {
    const input = fixture();
    const first = projectOrdinaryOpenShellCodexCapabilities({
      profiles: input.profiles,
      target: input.target,
      deployment: 'ordinary',
    });
    const source = input.profiles.ordinaryOpenShellCodexInventory(input.target.targetId, true);
    input.profiles.ordinaryOpenShellCodexInventory = () =>
      source.map((entry) => ({
        ...entry,
        label: 'Renamed account',
        models: entry.models.map((model) => ({ ...model, label: 'Renamed model' })),
        modelDiscovery: { ...entry.modelDiscovery, updatedAt: 987654 },
      }));
    expect(
      projectOrdinaryOpenShellCodexCapabilities({
        profiles: input.profiles,
        target: input.target,
        deployment: 'ordinary',
      }).inventory.capabilityRevision,
    ).toBe(first.inventory.capabilityRevision);
    source[0].models[0].reasoningEfforts = ['new-effort'];
    expect(
      projectOrdinaryOpenShellCodexCapabilities({
        profiles: input.profiles,
        target: input.target,
        deployment: 'ordinary',
      }).inventory.capabilityRevision,
    ).not.toBe(first.inventory.capabilityRevision);
  });
  it.each(['openai-codex', 'openai'] as const)('reuses the exact %s profile route', (provider) => {
    const input = fixture(provider);
    expect(assertOrdinaryOpenShellCodexRoute(input)).toMatchObject({
      provider: 'provider',
      model: 'fixture-model',
      kind: provider === 'openai' ? 'api' : 'chatgpt-subscription',
    });
  });
  it('rejects target configuration changes rather than consulting deployment defaults', () => {
    const input = fixture();
    input.target = ordinaryOpenShellCodexTarget({
      targetId: 'target',
      runtimeContractRevision: 'contract-r1',
      config: { ...config, gateway: 'changed' },
      openaiApi: 'enabled',
    });
    expect(() => assertOrdinaryOpenShellCodexRoute(input)).toThrow('route unavailable');
  });
  it.each(['revision', 'account', 'location', 'harness', 'mode', 'model', 'auth'])(
    'rejects incompatible %s',
    (change) => {
      const input = fixture();
      if (change === 'revision') input.binding.execution.targetRevision = 'changed';
      if (change === 'account') input.account.profileRevision = 'changed';
      if (change === 'location') input.binding.execution.location = 'local';
      if (change === 'harness') input.binding.harness.implementation = 'responses';
      if (change === 'mode') Object.assign(input, { mode: 'ask' });
      if (change === 'model') input.model = 'missing';
      if (change === 'auth')
        Object.assign(input.catalog.accounts[0], { auth: { kind: 'host-login' } });
      expect(() => assertOrdinaryOpenShellCodexRoute(input)).toThrow('route unavailable');
    },
  );
  it('keeps physical and provider identity while allowing a future model snapshot', () => {
    const input = fixture();
    const artifact = retained(assertOrdinaryOpenShellCodexRoute(input));
    artifact.route.model = 'old-model';
    expect(
      assertOrdinaryOpenShellCodexRoute({
        ...input,
        retained: artifact,
        expectedRetained: structuredClone(artifact),
      }).model,
    ).toBe('fixture-model');
    const changed = structuredClone(artifact);
    changed.runtime.sandboxId = 'different-owner';
    expect(() =>
      assertOrdinaryOpenShellCodexRoute({
        ...input,
        retained: artifact,
        expectedRetained: changed,
      }),
    ).toThrow();
    changed.runtime = structuredClone(artifact.runtime);
    changed.route.provider = 'another-provider';
    expect(() =>
      assertOrdinaryOpenShellCodexRoute({ ...input, retained: changed, expectedRetained: changed }),
    ).toThrow();
    expect(() => assertOrdinaryOpenShellCodexRoute({ ...input, retained: artifact })).toThrow();
  });
  it.each(['host', 'native', 'grant'])(
    'refuses incompatible subscription %s authority',
    (change) => {
      const input = fixture();
      const original = input.profiles.codexRoutingProfile.bind(input.profiles);
      input.profiles.codexRoutingProfile = (binding) => ({
        ...original(binding),
        ...(change === 'host' ? { credentialRef: '/fixture/login' } : {}),
        ...(change === 'native' ? { nativeAuth: 'sandbox-chatgpt' as const } : {}),
        ...(change === 'grant' ? { sandboxGrantId: undefined } : {}),
      });
      expect(() => assertOrdinaryOpenShellCodexRoute(input)).toThrow();
    },
  );
  it('refuses ambiguous API plan subscription profiles', () => {
    const input = fixture();
    const original = input.profiles.codexRoutingProfile.bind(input.profiles);
    input.profiles.codexRoutingProfile = (binding) => ({ ...original(binding), planType: ' API ' });
    expect(() => assertOrdinaryOpenShellCodexRoute(input)).toThrow();
  });
});
