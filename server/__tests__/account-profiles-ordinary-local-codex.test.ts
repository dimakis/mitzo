import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountProfiles } from '../account-profiles.js';
import {
  resolveOrdinarySessionRuntime,
  type OrdinarySessionRuntimeCatalog,
} from '../ordinary-session-runtime.js';

const boundaries = vi.hoisted(() => ({
  protectRoots: vi.fn(),
  readFile: vi.fn(),
  homedir: vi.fn(),
  enrollment: vi.fn(),
  cachedModels: vi.fn(),
  refreshModels: vi.fn(),
  readCodexModels: vi.fn(),
  verify: vi.fn(),
  config: vi.fn(),
  manager: vi.fn(),
  launch: vi.fn(),
  launchOpenShell: vi.fn(),
}));

vi.mock('../codex-private-path.js', () => ({ protectCodexProfileRoots: boundaries.protectRoots }));
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  readFileSync: boundaries.readFile,
}));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  homedir: boundaries.homedir,
}));
vi.mock('../openai-account-enrollment.js', () => ({
  readReadyOpenAIAccountProfiles: boundaries.enrollment,
}));
vi.mock('../model-catalog.js', async (original) => ({
  ...(await original<typeof import('../model-catalog.js')>()),
  cachedModels: boundaries.cachedModels,
  refreshModels: boundaries.refreshModels,
  readCodexModels: boundaries.readCodexModels,
}));
vi.mock('../codex-account.js', () => ({ verifyCodexAccount: boundaries.verify }));
vi.mock('../openshell-runtime.js', () => ({
  openShellRuntimeConfig: boundaries.config,
  OpenShellRuntimeManager: boundaries.manager,
}));
vi.mock('../codex-app-server-client.js', () => ({
  CodexAppServerClient: {
    launch: boundaries.launch,
    launchOpenShell: boundaries.launchOpenShell,
  },
}));

// Offline model metadata only; no provider call or charged account.
const models = [{ id: 'gpt-test', label: 'GPT test' }];
const host = {
  id: 'host',
  label: 'Private host label',
  provider: 'openai-codex',
  credentialRef: '/private/test-codex-login',
  email: 'private@example.test',
  planType: 'pro',
  workspaceId: 'private-workspace',
  models,
};
const broker = {
  id: 'broker',
  label: 'Private broker label',
  provider: 'openai-codex',
  email: 'broker@example.test',
  planType: 'plus',
  sandboxProvider: 'private-provider',
  sandboxProviderType: 'openai-codex-oauth',
  sandboxProviderId: 'private-provider-id',
  sandboxGrantId: 'private-grant-id',
  models,
};
const native = {
  id: 'native',
  label: 'Private native label',
  provider: 'openai-codex',
  nativeAuth: 'sandbox-chatgpt',
  email: 'native@example.test',
  planType: 'pro',
  sandboxProvider: 'native-provider',
  sandboxProviderType: 'codex',
  sandboxProviderId: 'native-provider-id',
  models,
};
const api = {
  id: 'api',
  label: 'Private API label',
  provider: 'openai',
  credentialRef: { provider: 'keychain', service: 'private-service', account: 'private-account' },
  sandboxProvider: 'api-provider',
  sandboxProviderId: 'api-provider-id',
  models,
};
const vertex = {
  id: 'vertex',
  label: 'Private Vertex label',
  provider: 'anthropic-vertex',
  projectId: 'private-project',
  region: 'us-east5',
  credentialRef: '/private/test-adc.json',
  sandboxProvider: 'vertex-provider',
  sandboxProviderId: 'vertex-provider-id',
  models,
};
const google = { ...vertex, id: 'google', provider: 'google-vertex' };
const mixed = [host, broker, native, api, vertex, google];

function configuration(profiles: AccountProfiles): OrdinarySessionRuntimeCatalog {
  return {
    deployment: 'ordinary',
    enabledHarnesses: ['codex'],
    accounts: profiles.ordinaryLocalCodexAccounts(),
    targets: [{ targetId: 'local', location: 'local' }],
  };
}

afterEach(() => vi.restoreAllMocks());

describe('dormant ordinary local Codex account projection', () => {
  it('projects the exact resolved routing reference with only configured auth metadata', () => {
    const profiles = new AccountProfiles(mixed, { codexEnabled: true });
    const { accountId, provider, profileRevision } = profiles.resolve('host', 'gpt-test', true);
    expect(profiles.ordinaryLocalCodexAccounts()).toEqual([
      { accountId, provider, profileRevision, planType: 'pro', auth: { kind: 'host-login' } },
    ]);
  });

  it.each([undefined, false])('honors the Codex gate %s', (codexEnabled) => {
    expect(new AccountProfiles(mixed, { codexEnabled }).ordinaryLocalCodexAccounts()).toEqual([]);
  });

  it('keeps host profiles with a legacy provider name local without exposing that name', () => {
    const profiles = new AccountProfiles(
      [{ ...host, sandboxProvider: 'private-legacy-provider' }],
      { codexEnabled: true },
    );
    const [account] = profiles.ordinaryLocalCodexAccounts();
    expect(account.auth).toEqual({ kind: 'host-login' });
    expect(account.profileRevision).toBe(
      profiles.resolve('host', 'gpt-test', true).profileRevision,
    );
    expect(JSON.stringify(account)).not.toContain('private-legacy-provider');
  });

  it.each(['api', 'API', ' Api ', '\tApI\n'])(
    'excludes ambiguous host plan %j without changing existing profile acceptance',
    (planType) => {
      const profiles = new AccountProfiles([{ ...host, planType }], { codexEnabled: true });
      expect(profiles.resolve('host', 'gpt-test', true).provider).toBe('openai-codex');
      expect(profiles.ordinaryLocalCodexAccounts()).toEqual([]);
    },
  );

  it('excludes native, brokered-only and other providers with no host fallback', () => {
    const profiles = new AccountProfiles([broker, native, api, vertex, google], {
      codexEnabled: true,
    });
    expect(profiles.ordinaryLocalCodexAccounts()).toEqual([]);
  });

  it('excludes a legacy whitespace-only plan without poisoning a valid host catalog', () => {
    const profiles = new AccountProfiles(
      [host, { ...host, id: 'blank-plan', planType: ' \t\n ' }],
      { codexEnabled: true },
    );
    expect(profiles.resolve('blank-plan', 'gpt-test', true).provider).toBe('openai-codex');
    const { accountId, provider, profileRevision } = profiles.resolve('host', 'gpt-test', true);
    expect(
      resolveOrdinarySessionRuntime(
        {
          account: { accountId, provider, profileRevision },
          harness: 'codex',
          targetId: 'local',
          mode: 'agent',
        },
        configuration(profiles),
      ).status,
    ).toBe('compatible');
    expect(profiles.ordinaryLocalCodexAccounts().map((account) => account.accountId)).toEqual([
      'host',
    ]);
  });

  it('excludes a legacy account ID outside runtime reference bounds without poisoning the catalog', () => {
    const longId = 'h'.repeat(201);
    const profiles = new AccountProfiles([host, { ...host, id: longId }], { codexEnabled: true });
    expect(profiles.resolve(longId, 'gpt-test', true).accountId).toBe(longId);
    const { accountId, provider, profileRevision } = profiles.resolve('host', 'gpt-test', true);
    expect(
      resolveOrdinarySessionRuntime(
        {
          account: { accountId, provider, profileRevision },
          harness: 'codex',
          targetId: 'local',
          mode: 'agent',
        },
        configuration(profiles),
      ).status,
    ).toBe('compatible');
    expect(profiles.ordinaryLocalCodexAccounts().map((account) => account.accountId)).toEqual([
      'host',
    ]);
  });

  it('returns independent plain copies without presentation, credentials or readiness claims', () => {
    const input = structuredClone(host);
    const profiles = new AccountProfiles([input], { codexEnabled: true });
    input.email = 'changed-input@example.test';
    input.planType = 'api';
    const first = profiles.ordinaryLocalCodexAccounts();
    const original = structuredClone(first);
    expect(Object.getPrototypeOf(first[0])).toBe(Object.prototype);
    expect(Object.getPrototypeOf(first[0].auth)).toBe(Object.prototype);
    expect(Object.keys(first[0]).sort()).toEqual([
      'accountId',
      'auth',
      'planType',
      'profileRevision',
      'provider',
    ]);
    expect(Object.keys(first[0].auth)).toEqual(['kind']);
    for (const value of [host.label, host.email, host.credentialRef, host.workspaceId, 'gpt-test'])
      expect(JSON.stringify(first)).not.toContain(value);
    first[0].accountId = 'mutated';
    first[0].profileRevision = 'mutated';
    first[0].planType = 'api';
    first[0].auth.kind = 'sandbox-chatgpt';
    first.push(first[0]);
    expect(profiles.ordinaryLocalCodexAccounts()).toEqual(original);
  });

  it('projects from the validated snapshot without lookup, discovery or runtime effects', () => {
    vi.clearAllMocks();
    const profiles = new AccountProfiles(mixed, { codexEnabled: true });
    expect(boundaries.protectRoots).toHaveBeenCalledExactlyOnceWith([
      host.credentialRef,
      vertex.credentialRef,
      google.credentialRef,
    ]);
    // Root protection belongs to construction; measure only projection effects.
    vi.clearAllMocks();
    const methods = ['resolve', 'catalog', 'refresh', 'signIn'] as const;
    const forbidden = methods.map((method) =>
      vi
        .spyOn(profiles as unknown as Record<(typeof methods)[number], () => never>, method)
        .mockImplementation(() => {
          throw new Error(`Unexpected ${method}`);
        }),
    );
    const env = process.env;
    const environmentReads: PropertyKey[] = [];
    let result;
    try {
      process.env = new Proxy(env, {
        get(target, key) {
          environmentReads.push(key);
          return Reflect.get(target, key);
        },
      });
      result = profiles.ordinaryLocalCodexAccounts();
    } finally {
      process.env = env;
    }
    expect(result).toHaveLength(1);
    expect(environmentReads).toEqual([]);
    for (const call of [...Object.values(boundaries), ...forbidden])
      expect(call).not.toHaveBeenCalled();
  });
});

describe('routing revision compatibility', () => {
  // Captured from resolve(..., configured=true) at accepted bfccd760 before extraction.
  it.each([
    [host, '74bde1ce2f5d75224b7a038bbfbf57ba39a7c1d00246b299f5ee7fcf932d41be'],
    [broker, '6a47476487e4c970b105c5205d9e45f1d6e3eac0364f8393445dff4aff282c98'],
    [native, '6170f757150cf7b93618a4ee93208d4fc11fb4c2741245aae9a94e6576ee40ce'],
    [
      { ...native, id: 'native-revision', nativeCatalogRevision: 7 },
      '4a1ef218d1f1b190a5c016926605fbe457bbee7b2a37c7d401c25b6d522ae3d7',
    ],
    [api, 'f0c2292041e6dac789bc682e5cfbccf65b7c5a4112426516cffa3faa04d854bf'],
    [vertex, 'ce81f2a240479f4dd81c07960caf300f3dece69734709d365df99bf3450c3c81'],
    [google, 'b327f706870201a84278194b1fad9a3619b91d4874bdbd61ea2b85170410dc3b'],
  ])('preserves persisted revision for $id', (profile, revision) => {
    const profiles = new AccountProfiles([profile], { codexEnabled: true });
    expect(profiles.resolve(profile.id, 'gpt-test', true).profileRevision).toBe(revision);
  });

  it('does not change routing revisions when labels or model allowlists change', () => {
    for (const profile of mixed) {
      const before = new AccountProfiles([profile], { codexEnabled: true });
      const after = new AccountProfiles(
        [
          {
            ...profile,
            label: 'Renamed',
            models: [{ id: 'other', label: 'Other' }],
          },
        ],
        { codexEnabled: true },
      );
      expect(after.resolve(profile.id, 'other', true).profileRevision).toBe(
        before.resolve(profile.id, 'gpt-test', true).profileRevision,
      );
      expect(after.ordinaryLocalCodexAccounts()).toEqual(before.ordinaryLocalCodexAccounts());
    }
  });
});

describe('projected accounts in the dormant resolver', () => {
  it('accepts the exact resolved account reference for explicit local Codex', () => {
    const profiles = new AccountProfiles(mixed, { codexEnabled: true });
    const { accountId, provider, profileRevision } = profiles.resolve('host', 'gpt-test', true);
    const account = { accountId, provider, profileRevision };
    expect(
      resolveOrdinarySessionRuntime(
        { account, harness: 'codex', targetId: 'local', mode: 'agent' },
        configuration(profiles),
      ),
    ).toEqual({
      status: 'compatible',
      targetId: 'local',
      binding: {
        version: 1,
        account,
        harness: { implementation: 'codex' },
        execution: { location: 'local' },
      },
    });
  });

  it.each([
    { credentialRef: '/private/rotated-codex-login' },
    { email: 'rotated@example.test' },
    { planType: 'plus' },
    { workspaceId: 'rotated-workspace' },
    { sandboxProvider: 'rotated-provider' },
  ])('rejects the old routing reference after rotation %j', (change) => {
    const before = new AccountProfiles([host], { codexEnabled: true });
    const after = new AccountProfiles([{ ...host, ...change }], { codexEnabled: true });
    const { accountId, provider, profileRevision } = before.resolve('host', 'gpt-test', true);
    const selection = {
      account: { accountId, provider, profileRevision },
      harness: 'codex',
      targetId: 'local',
      mode: 'agent',
    };
    expect(resolveOrdinarySessionRuntime(selection, configuration(after))).toEqual({
      status: 'rejected',
      code: 'account_identity_mismatch',
    });
    expect(() => after.resume(before.resolve('host', 'gpt-test', true))).toThrow(/changed/);
  });

  it.each([broker, native, api, vertex, google, { ...host, planType: ' Api ' }])(
    'cannot select an excluded profile $id through projected metadata',
    (profile) => {
      const profiles = new AccountProfiles([profile], { codexEnabled: true });
      const { accountId, provider, profileRevision } = profiles.resolve(
        profile.id,
        'gpt-test',
        true,
      );
      expect(
        resolveOrdinarySessionRuntime(
          {
            account: { accountId, provider, profileRevision },
            harness: 'codex',
            targetId: 'local',
            mode: 'agent',
          },
          configuration(profiles),
        ),
      ).toEqual({ status: 'rejected', code: 'account_unavailable' });
    },
  );
});
