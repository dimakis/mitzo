import { expect, it, vi } from 'vitest';
import { guardDiscoveryOperations } from '../symposium-discovery-custody.js';
import type { DiscoveryOperations } from '../symposium-model-discovery.js';

it('fences every operation and client response across asynchronous receipt changes', async () => {
  let current = true;
  const check = () => {
    if (!current) throw new Error('changed');
  };
  const client = {
    initialize: vi.fn(async () => {}),
    request: vi.fn(async () => {
      current = false;
      return {};
    }),
    close: vi.fn(),
  };
  const base = {
    openClient: async () => client,
    list: async () => {
      current = false;
      return [];
    },
  } as unknown as DiscoveryOperations;
  const ops = guardDiscoveryOperations(base, check);
  const opened = await ops.openClient({ name: 'md-aaaaaaaaaaaaaaaa', claim: '', configHash: '' });
  await expect(opened.request('model/list', {})).rejects.toThrow('changed');
  opened.close();
  expect(client.close).toHaveBeenCalledOnce();
  current = true;
  await expect(ops.list()).rejects.toThrow('changed');
});
it.each([null, {}, { type: 'apiKey' }, { type: 'chatgptAuthTokens' }])(
  'rejects missing or non-ChatGPT native authentication (%j)',
  async (account) => {
    const client = { initialize: vi.fn(), request: async () => ({ account }), close: vi.fn() };
    const ops = guardDiscoveryOperations(
      { openClient: async () => client } as unknown as DiscoveryOperations,
      () => {},
    );
    const opened = await ops.openClient({ name: 'md-aaaaaaaaaaaaaaaa', claim: '', configHash: '' });
    await expect(opened.request('account/read', { refreshToken: false })).rejects.toThrow(
      'authenticated',
    );
  },
);

it('closes a newly opened client if custody changes during opening', async () => {
  let current = true;
  const close = vi.fn();
  const ops = guardDiscoveryOperations(
    {
      openClient: async () => {
        current = false;
        return { close };
      },
    } as unknown as DiscoveryOperations,
    () => {
      if (!current) throw new Error('changed');
    },
  );
  await expect(
    ops.openClient({ name: 'md-aaaaaaaaaaaaaaaa', claim: '', configHash: '' }),
  ).rejects.toThrow('changed');
  expect(close).toHaveBeenCalledOnce();
});

it.each([undefined, 'unknown'])(
  'accepts the pinned native launcher display projection under verified receipt custody (plan=%s)',
  async (planType) => {
    const value = {
      account: {
        type: 'chatgpt',
        email: 'app-server@openshell.local',
        ...(planType === undefined ? {} : { planType }),
      },
    };
    const check = vi.fn();
    const request = vi.fn(async () => value);
    const ops = guardDiscoveryOperations(
      {
        openClient: async () => ({ initialize: async () => {}, request, close() {} }),
      } as unknown as DiscoveryOperations,
      check,
    );
    const client = await ops.openClient({ name: 'md-aaaaaaaaaaaaaaaa', claim: '', configHash: '' });
    expect(await client.request('account/read', { refreshToken: false })).toBe(value);
    expect(check).toHaveBeenCalledTimes(4);
    expect(request).toHaveBeenCalledWith('account/read', { refreshToken: false });
  },
);

it('rejects synthetic display success when the verified receipt changes during account read', async () => {
  let current = true;
  const check = () => {
    if (!current) throw new Error('verified receipt changed');
  };
  const ops = guardDiscoveryOperations(
    {
      openClient: async () => ({
        initialize: async () => {},
        close() {},
        request: async () => {
          current = false;
          return {
            account: { type: 'chatgpt', email: 'app-server@openshell.local', planType: 'unknown' },
          };
        },
      }),
    } as unknown as DiscoveryOperations,
    check,
  );
  const client = await ops.openClient({ name: 'md-aaaaaaaaaaaaaaaa', claim: '', configHash: '' });
  await expect(client.request('account/read', { refreshToken: false })).rejects.toThrow(
    'verified receipt changed',
  );
});
