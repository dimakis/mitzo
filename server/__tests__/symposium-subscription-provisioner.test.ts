import { describe, expect, it, vi } from 'vitest';
import {
  SymposiumSubscriptionProvisioner,
  attendSubscriptionLogin,
} from '../symposium-subscription-provisioner.js';

function fixture() {
  const binding = {
    accountId: 'personal',
    accountLabel: 'Personal',
    provider: 'openai-codex' as const,
    model: 'gpt-5.6-luna',
    profileRevision: 'revision',
  };
  const host = {
    workspace: 'workspace',
    verifyCustody: vi.fn(),
    run: vi.fn(async (args: string[], _environment?: Record<string, string>): Promise<unknown> =>
      args[1] === 'create'
        ? undefined
        : args[1] === 'list'
          ? {
              providers: [
                {
                  id: 'provider-id',
                  name: host.run.mock.calls[0][0][3],
                  type: 'codex',
                  workspace: 'workspace',
                },
              ],
              next_page_token: '',
            }
          : undefined,
    ),
    installProfile: vi.fn().mockResolvedValue(binding),
  };
  const auth = {
    fetch: vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'fake-access',
        refresh_token: 'fake-refresh',
        id_token: 'fake-id',
      }),
    }),
    verifyIdToken: vi.fn().mockResolvedValue({
      sub: 'subject',
      email: 'personal@example.invalid',
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'actual-account',
        chatgpt_plan_type: 'pro',
      },
    }),
  };
  const service = new SymposiumSubscriptionProvisioner(host, auth);
  const begin = () => {
    const login = new URL(service.begin());
    const callback = new URL('http://localhost:1455/auth/callback');
    callback.search = new URLSearchParams({
      state: login.searchParams.get('state')!,
      code: 'fake-code',
    }).toString();
    return callback;
  };
  return { service, host, auth, begin, binding };
}

describe('owned subscription provisioning', () => {
  it('keeps launch identity private and rejects changed receipt/provider/binding authority', async () => {
    const f = fixture();
    await f.service.complete(f.begin());
    const discovery = f.service.captureDiscovery();
    const input = {
      execution: { seat: { accountBinding: f.binding } },
      route: {
        kind: 'chatgpt-subscription-native',
        model: f.binding.model,
        provider: discovery.provider.name,
        providerId: discovery.provider.id,
        profile: { model: f.binding.model, email: 'personal@example.invalid', planType: 'pro' },
      },
    } as never;
    const launch = f.service.captureLaunchIdentity(input);
    expect(launch.accountId).toBe('actual-account');
    expect(() => launch.assertCurrent()).not.toThrow();
    expect(JSON.stringify(discovery)).not.toContain('actual-account');
    expect(JSON.stringify(f.binding)).not.toContain('actual-account');
    const changed = structuredClone(input) as unknown as { route: { providerId: string } };
    changed.route.providerId = 'replacement-provider';
    expect(() => f.service.captureLaunchIdentity(changed as never)).toThrow('receipt');
    discovery.publishBinding({ ...f.binding, profileRevision: 'new-revision' });
    expect(() => launch.assertCurrent()).toThrow('receipt');
    const metadata = discovery.launchIdentity;
    expect(() => metadata()).toThrow('receipt changed');
    f.service.invalidate();
    expect(() => launch.assertCurrent()).toThrow('receipt');
  });

  it('exchanges fresh PKCE login, verifies identity and provisions with secrets only in environment', async () => {
    const f = fixture();
    const result = await f.service.complete(f.begin());
    expect(result.accountId).toBe('actual-account');
    expect(f.auth.verifyIdToken).toHaveBeenCalledWith('fake-id', expect.any(String));
    expect(f.host.run).toHaveBeenCalledTimes(3);
    for (const [args] of f.host.run.mock.calls)
      expect(JSON.stringify(args)).not.toMatch(/fake-access|fake-refresh|fake-id/);
    expect(f.host.run.mock.calls[0][1]).toEqual({
      CODEX_AUTH_ACCESS_TOKEN: 'fake-access',
      CODEX_AUTH_ACCOUNT_ID: 'actual-account',
    });
  });
  it('rejects state mismatch without token exchange and consumes a successful callback once', async () => {
    const f = fixture();
    const callback = f.begin();
    const wrong = new URL(callback);
    wrong.searchParams.set('state', 'wrong');
    await expect(f.service.complete(wrong)).rejects.toThrow('callback');
    expect(f.auth.fetch).not.toHaveBeenCalled();
    await f.service.complete(callback);
    await expect(f.service.complete(callback)).rejects.toThrow('callback');
  });
  it('never provisions unverified or nonpersonal identity', async () => {
    const f = fixture();
    f.auth.verifyIdToken.mockRejectedValue(new Error('fake secret must not escape'));
    await expect(f.service.complete(f.begin())).rejects.toThrow('authorization remains closed');
    expect(f.host.run).not.toHaveBeenCalled();
    const g = fixture();
    g.auth.verifyIdToken.mockResolvedValue({
      sub: 's',
      email: 'e',
      'https://api.openai.com/auth': { chatgpt_account_id: 'a', chatgpt_plan_type: 'team' },
    });
    await expect(g.service.complete(g.begin())).rejects.toThrow('authorization remains closed');
    expect(g.host.run).not.toHaveBeenCalled();
  });
  it('does not provision after cancellation during OAuth verification', async () => {
    const f = fixture();
    let release!: (value: Awaited<ReturnType<typeof f.auth.verifyIdToken>>) => void;
    f.auth.verifyIdToken.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const completion = f.service.complete(f.begin());
    await vi.waitFor(() => expect(f.auth.verifyIdToken).toHaveBeenCalled());
    f.service.invalidate();
    release({
      sub: 'subject',
      email: 'personal@example.invalid',
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'actual-account',
        chatgpt_plan_type: 'pro',
      },
    });
    await expect(completion).rejects.toThrow('authorization remains closed');
    expect(f.host.run).not.toHaveBeenCalled();
  });
  it('retains no authority after custody loss or new login', async () => {
    const f = fixture();
    await f.service.complete(f.begin());
    const profile = f.host.installProfile.mock.calls[0][0];
    const input = {
      execution: { seat: { accountBinding: f.binding } },
      route: {
        kind: 'chatgpt-subscription-native',
        provider: profile.provider,
        providerId: profile.providerId,
        profile: { ...profile, model: f.binding.model },
        model: f.binding.model,
      },
    } as Parameters<typeof f.service.verifyPrivateAuth>[0];
    await expect(f.service.verifyPrivateAuth(input)).resolves.toBeUndefined();
    f.host.verifyCustody.mockImplementation(() => {
      throw new Error('custody lost');
    });
    await expect(f.service.verifyPrivateAuth(input)).rejects.toThrow('custody was lost');
    f.host.verifyCustody.mockReset();
    f.service.begin();
    await expect(f.service.verifyPrivateAuth(input)).rejects.toThrow('receipt');
    await expect(
      new SymposiumSubscriptionProvisioner(f.host, f.auth).verifyPrivateAuth(input),
    ).rejects.toThrow('receipt');
  });
});

it('closes a failed attended login so another attempt can bind immediately', async () => {
  const { service, auth } = fixture();
  auth.fetch.mockResolvedValue({
    ok: false,
    json: async () => ({ access_token: '', refresh_token: '', id_token: '' }),
  });
  const login = await attendSubscriptionLogin(service);
  const rejected = expect(login.completed).rejects.toThrow('Subscription login failed');
  try {
    const state = new URL(login.authorizationUrl).searchParams.get('state')!;
    const response = await fetch(
      `http://localhost:1455/auth/callback?code=fake-code&state=${state}`,
    );
    expect(response.status).toBe(400);
    await rejected;
    const retry = await attendSubscriptionLogin(service);
    const cancelled = expect(retry.completed).rejects.toThrow('cancelled');
    retry.cancel();
    await cancelled;
  } finally {
    login.cancel();
  }
});

it('imports only a fresh device login through verified identity and the same custody installer', async () => {
  const f = fixture();
  const finish = f.service.beginDevice();
  await finish({
    access_token: 'device-access',
    refresh_token: 'device-refresh',
    id_token: 'device-id',
    account_id: 'actual-account',
  });
  expect(f.auth.verifyIdToken).toHaveBeenCalledWith('device-id', undefined);
  expect(f.host.installProfile).toHaveBeenCalledWith(
    expect.objectContaining({ accountId: 'actual-account' }),
  );
  expect(f.auth.fetch).not.toHaveBeenCalled();
  await expect(
    finish({
      access_token: 'device-access',
      refresh_token: 'device-refresh',
      id_token: 'device-id',
      account_id: 'actual-account',
    }),
  ).rejects.toThrow();
});
it('fences a cancelled device completion and rejects a mismatched cached identity', async () => {
  const f = fixture();
  const finish = f.service.beginDevice();
  f.service.invalidate();
  await expect(
    finish({ access_token: 'a', refresh_token: 'r', id_token: 'i', account_id: 'actual-account' }),
  ).rejects.toThrow();
  expect(f.host.run).not.toHaveBeenCalled();
  const g = fixture();
  await expect(
    g.service.beginDevice()({
      access_token: 'a',
      refresh_token: 'r',
      id_token: 'i',
      account_id: 'another',
    }),
  ).rejects.toThrow();
  expect(g.host.run).not.toHaveBeenCalled();
});

it('fences credentials and refuses deletion while any sandbox holds the provider', async () => {
  const f = fixture();
  await f.service.complete(f.begin());
  const provider = f.host.run.mock.calls[0][0][3];
  f.host.run.mockImplementation(async (args) =>
    args[0] === 'sandbox'
      ? args[1] === 'list'
        ? { sandboxes: [{ name: 'seat' }], next_page_token: '' }
        : { providers: [{ name: provider, type: 'codex' }], next_page_token: '' }
      : (undefined as never),
  );
  await expect(f.service.disconnect()).rejects.toThrow('cleanup');
  expect(f.host.run.mock.calls.some(([args]) => args.includes('delete'))).toBe(false);
});
it('removes refresh material then provider and verifies absence', async () => {
  const f = fixture();
  await f.service.complete(f.begin());
  f.host.run.mockImplementation(async (args) =>
    args[0] === 'sandbox'
      ? { sandboxes: [], next_page_token: '' }
      : args[1] === 'list'
        ? { providers: [], next_page_token: '' }
        : (undefined as never),
  );
  await f.service.disconnect();
  const operations = f.host.run.mock.calls.map(([args]) => args);
  expect(operations.some((args) => args.slice(0, 3).join(' ') === 'provider refresh delete')).toBe(
    true,
  );
  expect(operations.some((args) => args.slice(0, 2).join(' ') === 'provider delete')).toBe(true);
});

it('refuses even detached or unrelated surviving sandboxes without credential deletion lineage', async () => {
  const f = fixture();
  await f.service.complete(f.begin());
  f.host.run.mockImplementation(async (args) =>
    args[0] === 'sandbox'
      ? { sandboxes: [{ name: 'unrelated', state: 'Stopped' }], next_page_token: '' }
      : { providers: [], next_page_token: '' },
  );
  await expect(f.service.disconnect()).rejects.toThrow('cleanup');
  expect(f.host.run.mock.calls.some(([args]) => args.includes('delete'))).toBe(false);
});
it('does not certify cleanup when a starting sandbox appears after provider deletion', async () => {
  const f = fixture();
  await f.service.complete(f.begin());
  let inventories = 0;
  f.host.run.mockImplementation(async (args) =>
    args[0] === 'sandbox'
      ? {
          sandboxes: ++inventories === 1 ? [] : [{ name: 'late-seat', state: 'Creating' }],
          next_page_token: '',
        }
      : args[1] === 'list'
        ? { providers: [], next_page_token: '' }
        : undefined,
  );
  await expect(f.service.disconnect()).rejects.toThrow('cleanup');
  expect(inventories).toBe(2);
  await expect(f.service.disconnect()).rejects.toThrow('cleanup');
});

it('retries verified cleanup after a late sandbox disappears without repeating acknowledged deletes', async () => {
  const f = fixture();
  await f.service.complete(f.begin());
  let sandboxReads = 0;
  let retry = false;
  const deleted = new Set<string>();
  f.host.run.mockImplementation(async (args) => {
    if (args[0] === 'sandbox')
      return {
        sandboxes: !retry && ++sandboxReads > 1 ? [{ name: 'late-seat', state: 'Creating' }] : [],
        next_page_token: '',
      };
    if (args[1] === 'list') return { providers: [], next_page_token: '' };
    const operation = args.slice(0, 3).join(' ');
    if (deleted.has(operation)) throw new Error('NotFound: refresh record or provider is absent');
    deleted.add(operation);
    return undefined;
  });
  await expect(f.service.disconnect()).rejects.toThrow('cleanup');
  retry = true;
  await expect(f.service.disconnect()).resolves.toBeUndefined();
  expect(deleted.size).toBe(2);
  expect(
    f.host.run.mock.calls.filter(([args]) => args[1] === 'refresh' && args[2] === 'delete'),
  ).toHaveLength(1);
  expect(f.host.run.mock.calls.filter(([args]) => args[1] === 'delete')).toHaveLength(1);
});
it('retains acknowledged refresh deletion when provider deletion needs a retry', async () => {
  const f = fixture();
  await f.service.complete(f.begin());
  let refreshDeleted = false;
  let providerAttempts = 0;
  f.host.run.mockImplementation(async (args) => {
    if (args[0] === 'sandbox') return { sandboxes: [], next_page_token: '' };
    if (args[1] === 'list') return { providers: [], next_page_token: '' };
    if (args[1] === 'refresh') {
      if (refreshDeleted) throw new Error('NotFound');
      refreshDeleted = true;
      return;
    }
    if (args[1] === 'delete' && ++providerAttempts === 1)
      throw new Error('Transient unacknowledged removal');
  });
  await expect(f.service.disconnect()).rejects.toThrow('cleanup');
  await expect(f.service.disconnect()).resolves.toBeUndefined();
  expect(providerAttempts).toBe(2);
});
it('does not treat an unacknowledged NotFound as proof that refresh material was deleted', async () => {
  const f = fixture();
  await f.service.complete(f.begin());
  f.host.run.mockImplementation(async (args) => {
    if (args[0] === 'sandbox') return { sandboxes: [], next_page_token: '' };
    throw new Error('NotFound');
  });
  await expect(f.service.disconnect()).rejects.toThrow('cleanup');
  await expect(f.service.disconnect()).rejects.toThrow('cleanup');
  expect(f.host.run.mock.calls.some(([args]) => args[1] === 'delete')).toBe(false);
});

it('captures only a live verified receipt and fences publication after receipt replacement', async () => {
  const f = fixture();
  expect(() => f.service.captureDiscovery()).toThrow('receipt');
  await f.service.complete(f.begin());
  const proof = f.service.captureDiscovery();
  expect(proof.provider).toEqual({ name: f.host.run.mock.calls[0][0][3], id: 'provider-id' });
  expect(() => proof.publishBinding({ ...f.binding, accountId: 'another' })).toThrow('account');
  proof.publishBinding({ ...f.binding, profileRevision: 'catalog-revision' });
  expect(() => proof.assertCurrent()).toThrow('changed');
  const newer = f.service.captureDiscovery();
  expect(newer.binding.profileRevision).toBe('catalog-revision');
  f.service.invalidate();
  expect(() => newer.assertCurrent()).toThrow('changed');
});

it('uses the supplied attempt deadline without extending custody', async () => {
  const f = fixture();
  const deadline = Date.now() + 10000;
  const finish = f.service.beginDevice(deadline);
  const now = vi.spyOn(Date, 'now').mockReturnValue(deadline);
  try {
    await expect(
      finish({
        access_token: 'a',
        refresh_token: 'r',
        id_token: 'i',
        account_id: 'actual-account',
      }),
    ).rejects.toThrow();
    expect(f.host.run).not.toHaveBeenCalled();
  } finally {
    now.mockRestore();
  }
});
