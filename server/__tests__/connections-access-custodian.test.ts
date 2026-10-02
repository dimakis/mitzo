import { describe, it, expect, vi } from 'vitest';
import {
  personalInventorySource,
  symposiumAccountsInventorySource,
} from '../connections-access-custodian.js';
import { readConnectionsAccess } from '../connections-access.js';
import { revokeAuthSession } from '../auth.js';
import type { PersonalConnection } from '../symposium-personal-connections.js';
import type { CustodianClient } from '../symposium-custodian-proxy.js';
const metadata: PersonalConnection = {
  id: 'personal_one',
  label: 'Personal',
  revision: 1,
  state: 'connected',
  account: { email: 'user@example.com', planType: 'plus' },
};
const auth = () => ({
  id: `browser-${Math.random().toString(36).slice(2)}`,
  expiresAt: Date.now() + 60_000,
});
describe('custodian personal metadata inventory', () => {
  it('uses existing personal.list with verified browser authority and never falls back to local ownership', async () => {
    const session = auth();
    const invoke = vi.fn<CustodianClient['request']>(async () => ({
      status: 200,
      body: { connections: [metadata] },
    }));
    const local = vi.fn(() => []);
    const personal = personalInventorySource(
      session,
      { request: invoke, invalidate: vi.fn() },
      local,
    )!;
    const result = await readConnectionsAccess({ personal });
    expect(result.sources.find((s) => s.id === 'personal')!.state).toBe('available');
    expect(result.resources[0].nativeId).toBe('personal_one');
    expect(invoke.mock.calls[0][0]).toMatchObject({
      operation: 'personal.list',
      body: {},
      query: {},
      authorization: session,
    });
    expect(invoke.mock.calls[0][0]).not.toHaveProperty('epoch');
    expect(local).not.toHaveBeenCalled();
  });
  it('reports failed owner HTTP responses as unavailable without exposing error body or local fallback', async () => {
    const local = vi.fn(() => [metadata]);
    const personal = personalInventorySource(
      auth(),
      {
        request: vi.fn(async () => ({ status: 503, body: { error: 'SECRET' } })),
        invalidate: vi.fn(),
      },
      local,
    )!;
    const result = await readConnectionsAccess({ personal });
    expect(result.sources.find((s) => s.id === 'personal')!.state).toBe('unavailable');
    expect(result.resources).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(local).not.toHaveBeenCalled();
  });
  it('invalidates in-flight owner authorization on logout and discards late metadata', async () => {
    const session = auth();
    let release!: () => void;
    const invalidate = vi.fn();
    const invoke = vi.fn<CustodianClient['request']>(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { status: 200, body: { connections: [metadata] } };
    });
    const personal = personalInventorySource(session, { request: invoke, invalidate })!;
    const result = readConnectionsAccess({ personal });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    revokeAuthSession(session);
    release();
    const inventory = await result;
    expect(invalidate).toHaveBeenCalledWith(session.id);
    expect(inventory.resources).toEqual([]);
    expect(inventory.sources.find((s) => s.id === 'personal')!.state).toBe('unavailable');
  });
  it('bounds a hung owner and supplies an aborted signal while retaining unrelated sources', async () => {
    let observedSignal: AbortSignal | undefined;
    const invoke = vi.fn<CustodianClient['request']>(async (_input, _approval, signal) => {
      observedSignal = signal;
      return new Promise<never>(() => {});
    });
    const personal = personalInventorySource(auth(), { request: invoke, invalidate: vi.fn() })!;
    const result = await readConnectionsAccess({ accounts: () => [], personal }, { timeoutMs: 10 });
    expect(observedSignal?.aborted).toBe(true);
    expect(result.sources.find((s) => s.id === 'personal')!.state).toBe('unavailable');
    expect(result.sources.find((s) => s.id === 'accounts')!.state).toBe('available');
  });
});

it('reads current Symposium catalog using existing account.catalog custody operation, without local fallback', async () => {
  const session = auth();
  const catalog = [
    {
      id: 'dynamic',
      label: 'Dynamic account',
      provider: 'openai' as const,
      billing: 'openai-api',
      models: [{ id: 'dynamic-model', label: 'Dynamic model' }],
      modelDiscovery: { stale: false },
      capabilities: { streaming: true, tools: true, images: false },
    },
  ];
  const invoke = vi.fn<CustodianClient['request']>(async () => ({ status: 200, body: catalog }));
  const local = vi.fn(() => []);
  const symposiumAccounts = symposiumAccountsInventorySource(
    session,
    { request: invoke, invalidate: vi.fn() },
    local,
  )!;
  const inventory = await readConnectionsAccess({ symposiumAccounts });
  expect(invoke.mock.calls[0][0]).toMatchObject({
    operation: 'account.catalog',
    body: {},
    query: {},
    authorization: session,
  });
  expect(local).not.toHaveBeenCalled();
  expect(inventory.resources[0].owner).toBe('symposium-account-profiles');
  expect(inventory.resources[0].details.models).toEqual(catalog[0].models);
});
it('marks unavailable custodian Symposium catalog as unavailable without controller-local fallback', async () => {
  const local = vi.fn(() => []);
  const symposiumAccounts = symposiumAccountsInventorySource(
    auth(),
    {
      request: vi.fn(async () => ({ status: 503, body: { error: 'SECRET' } })),
      invalidate: vi.fn(),
    },
    local,
  )!;
  const inventory = await readConnectionsAccess({ symposiumAccounts });
  expect(inventory.sources.find((source) => source.id === 'symposiumAccounts')!.state).toBe(
    'unavailable',
  );
  expect(local).not.toHaveBeenCalled();
  expect(JSON.stringify(inventory)).not.toContain('SECRET');
});
