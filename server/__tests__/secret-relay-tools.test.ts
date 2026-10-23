import { expect, it, vi } from 'vitest';
import {
  createCredentialConnectionTools,
  credentialConnectionSchemas,
} from '../credential-connection-tools.js';
import type { CredentialConnections } from '../credential-connections.js';
it('registers secret-free relay tools and never accepts secret values or destination changes on apply', async () => {
  expect(credentialConnectionSchemas).toHaveProperty('PrepareSecretRelay');
  expect(credentialConnectionSchemas).toHaveProperty('GetSecretRelay');
  expect(credentialConnectionSchemas).toHaveProperty('ApplySecretRelay');
  const relay = {
    status: vi.fn(() => ({ id: 'relay' })),
    apply: vi.fn(async () => ({ outcome: 'confirmed', status: 200 })),
  };
  const service = { relay } as unknown as CredentialConnections;
  const tools = createCredentialConnectionTools(service, 'chat', vi.fn(), () => true);
  expect(
    await tools.execute(
      'ApplySecretRelay',
      { relayId: 'relay', targetIndex: 0, secret: 'bad' },
      AbortSignal.timeout(1000),
    ),
  ).toMatchObject({ isError: true });
  expect(relay.apply).not.toHaveBeenCalled();
  const result = await tools.execute(
    'ApplySecretRelay',
    { relayId: 'relay', targetIndex: 0 },
    AbortSignal.timeout(1000),
  );
  expect(JSON.parse(result!.content)).toEqual({ outcome: 'confirmed', status: 200 });
  expect(relay.apply.mock.calls[0].slice(0, 3)).toEqual(['chat', 'relay', 0]);
});
it('treats apply as a write for permission checks', async () => {
  const relay = { apply: vi.fn() };
  const tools = createCredentialConnectionTools(
    { relay } as unknown as CredentialConnections,
    'chat',
    vi.fn(),
    (_tool, method) => method !== 'POST',
  );
  const result = await tools.execute(
    'ApplySecretRelay',
    { relayId: 'relay', targetIndex: 0 },
    AbortSignal.timeout(1000),
  );
  expect(result?.isError).toBe(true);
  expect(relay.apply).not.toHaveBeenCalled();
});
it('accepts only a reviewed browser action index and forwards no session material', async () => {
  const relay = { apply: vi.fn(async () => ({ outcome: 'confirmed' })) };
  const tools = createCredentialConnectionTools(
    { relay } as unknown as CredentialConnections,
    'chat',
    vi.fn(),
    () => true,
  );
  expect(
    (
      await tools.execute(
        'ApplySecretRelay',
        { relayId: 'relay', targetIndex: 0, actionIndex: 2 },
        AbortSignal.timeout(1000),
      )
    )?.isError,
  ).toBe(false);
  expect(relay.apply.mock.calls[0].at(-1)).toBe(2);
  expect(
    (
      await tools.execute(
        'ApplySecretRelay',
        { relayId: 'relay', targetIndex: 0, actionIndex: 2, cookie: 'private' },
        AbortSignal.timeout(1000),
      )
    )?.isError,
  ).toBe(true);
});
