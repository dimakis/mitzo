import { afterEach, expect, it, vi } from 'vitest';
import { AccountProfiles } from '../account-profiles.js';
import { readConnectionsAccess } from '../connections-access.js';
const transport = vi.hoisted(() => ({ check: vi.fn(), ensure: vi.fn(), launch: vi.fn() }));
vi.mock('../openshell-runtime.js', () => ({
  openShellRuntimeConfig: () => ({ image: 'test', gateway: 'test', workspace: 'test' }),
  OpenShellRuntimeManager: class {
    verifySubscriptionSignIn = transport.check;
    ensure = transport.ensure;
  },
}));
vi.mock('../codex-app-server-client.js', () => ({
  CodexAppServerClient: { launch: transport.launch },
}));
const profile = {
  id: 'personal',
  label: 'Personal',
  provider: 'openai-codex',
  email: 'configured@example.com',
  planType: 'pro',
  sandboxProvider: 'personal',
  sandboxProviderType: 'openai-codex-oauth',
  sandboxProviderId: 'provider-1',
  sandboxGrantId: 'grant-1',
  models: [{ id: 'luna', label: 'Luna' }],
};
afterEach(() => vi.clearAllMocks());
it('checks broker sign-in without a sandbox, model request or invented observed identity', async () => {
  transport.check.mockResolvedValue(undefined);
  const accounts = new AccountProfiles([profile], { codexEnabled: true });
  await accounts.checkSignIn(new AbortController().signal);
  expect(accounts.catalog()[0].signIn).toMatchObject({
    status: 'verified',
    source: 'openshell-provider-grant',
    configuredIdentity: { email: profile.email, planType: 'pro' },
    observedIdentity: null,
  });
  expect(transport.ensure).not.toHaveBeenCalled();
  expect(transport.launch).not.toHaveBeenCalled();
});
it('invalidates successful evidence after a failed recheck and sanitizes errors', async () => {
  const accounts = new AccountProfiles([profile], { codexEnabled: true });
  transport.check.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('SECRET'));
  await accounts.checkSignIn(new AbortController().signal);
  await accounts.checkSignIn(new AbortController().signal);
  expect(accounts.catalog()[0].signIn?.status).toBe('failed');
  expect(JSON.stringify(accounts.catalog())).not.toContain('SECRET');
});
it('does not carry evidence across profile changes and ages successful evidence', async () => {
  vi.useFakeTimers();
  try {
    transport.check.mockResolvedValue(undefined);
    const accounts = new AccountProfiles([profile], { codexEnabled: true });
    await accounts.checkSignIn(new AbortController().signal);
    vi.advanceTimersByTime(5 * 60_000 + 1);
    expect(accounts.catalog()[0].signIn?.status).toBe('stale');
    const changed = new AccountProfiles([{ ...profile, sandboxGrantId: 'grant-2' }], {
      codexEnabled: true,
    });
    expect(changed.catalog()[0].signIn?.status).toBe('not-checked');
    expect(changed.catalog()[0].signIn?.profileRevision).not.toBe(
      accounts.catalog()[0].signIn?.profileRevision,
    );
  } finally {
    vi.useRealTimers();
  }
});
it('does not launch a host login or treat native provider presence as sign-in', async () => {
  const native = { ...profile, sandboxGrantId: undefined };
  const accounts = new AccountProfiles(
    [
      {
        ...profile,
        id: 'host',
        sandboxProvider: undefined,
        sandboxProviderType: undefined,
        sandboxProviderId: undefined,
        sandboxGrantId: undefined,
        credentialRef: '/host/login',
      },
      { ...native, id: 'native', nativeAuth: 'sandbox-chatgpt', sandboxProviderType: 'codex' },
    ],
    { codexEnabled: true },
  );
  await accounts.checkSignIn(new AbortController().signal);
  expect(accounts.catalog().map((account) => account.signIn?.status)).toEqual([
    'not-checked',
    'unsupported',
  ]);
  expect(transport.check).not.toHaveBeenCalled();
  expect(transport.launch).not.toHaveBeenCalled();
});

it('preserves configured catalog when authentication times out before the inventory deadline', async () => {
  vi.useFakeTimers();
  try {
    transport.check.mockImplementation(() => new Promise(() => {}));
    const accounts = new AccountProfiles([profile], { codexEnabled: true, signInTimeoutMs: 100 });
    const pending = accounts.checkSignIn(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(accounts.catalog()).toHaveLength(1);
    expect(accounts.catalog()[0].signIn).toMatchObject({
      status: 'failed',
      observedIdentity: null,
    });
    expect(accounts.catalog()[0].signIn?.explanation).toContain('timed out');
  } finally {
    vi.useRealTimers();
  }
});

it('marks broker evidence stale as soon as its verified grant expires', async () => {
  vi.useFakeTimers();
  try {
    transport.check.mockResolvedValue(Date.now() + 100);
    const accounts = new AccountProfiles([profile], { codexEnabled: true });
    await accounts.checkSignIn(new AbortController().signal);
    expect(accounts.catalog()[0].signIn?.status).toBe('verified');
    vi.advanceTimersByTime(100);
    expect(accounts.catalog()[0].signIn?.status).toBe('stale');
  } finally {
    vi.useRealTimers();
  }
});

it('returns failed authentication as an available inventory account source', async () => {
  transport.check.mockRejectedValue(new Error('SECRET'));
  const accounts = new AccountProfiles([profile], { codexEnabled: true });
  const inventory = await readConnectionsAccess({
    accounts: async (signal) => {
      await accounts.checkSignIn(signal);
      return accounts.catalog();
    },
  });
  expect(inventory.sources.find((source) => source.id === 'accounts')?.state).toBe('available');
  expect(inventory.resources[0]).toMatchObject({
    accountIdentity: null,
    signIn: { status: 'failed', observedIdentity: null },
  });
  expect(inventory.resources[0].verification.state).toBe('unverified');
  expect(JSON.stringify(inventory)).not.toContain('SECRET');
});
it('records only verified host identity and invalidates it when account/read changes', async () => {
  const host = {
    ...profile,
    id: 'host-discovery-evidence',
    credentialRef: '/host/login',
    sandboxProvider: undefined,
    sandboxProviderType: undefined,
    sandboxProviderId: undefined,
    sandboxGrantId: undefined,
  };
  let email = host.email;
  const request = vi.fn(async (method: string) => {
    if (method === 'account/read')
      return { account: { type: 'chatgpt', email, planType: host.planType } };
    if (method === 'model/list')
      return {
        data: [
          {
            model: 'luna',
            displayName: 'Luna',
            supportedReasoningEfforts: [],
            defaultReasoningEffort: 'low',
          },
        ],
        nextCursor: null,
      };
    throw new Error('Unexpected request');
  });
  transport.launch.mockReturnValue({
    initialize: vi.fn().mockResolvedValue(undefined),
    request,
    close: vi.fn(),
  });
  const accounts = new AccountProfiles([host], { codexEnabled: true });
  await accounts.refresh(true);
  expect(accounts.catalog()[0].signIn).toMatchObject({
    status: 'verified',
    source: 'host-account-read',
    observedIdentity: { email: host.email, planType: host.planType },
  });
  email = 'other@example.com';
  await accounts.refresh(true);
  expect(accounts.catalog()[0].signIn).toMatchObject({ status: 'failed', observedIdentity: null });
});
it('shares host proof across profile reloads while isolating changed profiles and invalidating failures', async () => {
  const host = {
    ...profile,
    id: 'reloaded-host-proof',
    credentialRef: '/reloaded/login',
    sandboxProvider: undefined,
    sandboxProviderType: undefined,
    sandboxProviderId: undefined,
    sandboxGrantId: undefined,
  };
  let email = host.email;
  transport.launch.mockReturnValue({
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    request: vi.fn(async (method: string) =>
      method === 'account/read'
        ? { account: { type: 'chatgpt', email, planType: host.planType } }
        : {
            data: [
              {
                model: 'luna',
                displayName: 'Luna',
                supportedReasoningEfforts: [],
                defaultReasoningEffort: 'low',
              },
            ],
            nextCursor: null,
          },
    ),
  });
  await new AccountProfiles([host], { codexEnabled: true }).refresh(true);
  const reloaded = new AccountProfiles([host], { codexEnabled: true });
  expect(reloaded.catalog()[0].signIn).toMatchObject({
    status: 'verified',
    observedIdentity: { email: host.email },
  });
  expect(
    new AccountProfiles([{ ...host, label: 'Changed profile' }], {
      codexEnabled: true,
    }).catalog()[0].signIn?.status,
  ).toBe('not-checked');
  email = 'different@example.com';
  await new AccountProfiles([host], { codexEnabled: true }).refresh(true);
  expect(reloaded.catalog()[0].signIn).toMatchObject({ status: 'failed', observedIdentity: null });
});
