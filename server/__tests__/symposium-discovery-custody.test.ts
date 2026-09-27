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
  const ops = guardDiscoveryOperations(base, check, { email: 'a@example.test', planType: 'plus' });
  const opened = await ops.openClient({ name: 'md-aaaaaaaaaaaaaaaa', claim: '', configHash: '' });
  await expect(opened.request('model/list', {})).rejects.toThrow('changed');
  opened.close();
  expect(client.close).toHaveBeenCalledOnce();
  current = true;
  await expect(ops.list()).rejects.toThrow('changed');
});
it.each(['other@example.test', undefined])(
  'rejects a projected account differing from the verified receipt (%s)',
  async (email) => {
    const client = {
      initialize: vi.fn(),
      request: async () => ({ account: { type: 'chatgpt', email, planType: 'plus' } }),
      close: vi.fn(),
    };
    const ops = guardDiscoveryOperations(
      { openClient: async () => client } as unknown as DiscoveryOperations,
      () => {},
      { email: 'a@example.test', planType: 'plus' },
    );
    const opened = await ops.openClient({ name: 'md-aaaaaaaaaaaaaaaa', claim: '', configHash: '' });
    await expect(opened.request('account/read', { refreshToken: false })).rejects.toThrow(
      'account',
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
    { email: 'a@example.test', planType: 'plus' },
  );
  await expect(
    ops.openClient({ name: 'md-aaaaaaaaaaaaaaaa', claim: '', configHash: '' }),
  ).rejects.toThrow('changed');
  expect(close).toHaveBeenCalledOnce();
});
