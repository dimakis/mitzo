import { expect, it, vi } from 'vitest';
import { OpenShellRuntimeManager } from '../openshell-runtime.js';
const config = {
  cli: 'openshell',
  image: 'test',
  policy: '/policy',
  seed: '/seed',
  serviceProviders: [],
  grantableServiceProviders: [],
  workspace: 'mitzo',
  gateway: 'test',
  gatewayInsecure: false,
  createDetached: true,
  sandboxIdLength: 13,
  workdir: '/sandbox',
  webSearch: 'disabled' as const,
  account: {
    kind: 'chatgpt-subscription' as const,
    provider: 'personal',
    providerType: 'openai-codex-oauth' as const,
    providerId: 'provider-1',
    grantId: 'grant-1',
    model: 'luna',
  },
};
const provider = {
  name: 'personal',
  id: 'provider-1',
  workspace: 'mitzo',
  type: 'openai-codex-oauth',
};
const credential = {
  provider_name: 'personal',
  provider_id: 'provider-1',
  credential_key: 'OPENAI_CODEX_OAUTH_ACCESS_TOKEN',
  status: 'refreshed',
  expires_at_ms: Date.now() + 60_000,
  refresh_generation_id: 'grant-1',
};
it('uses exclusively read-only provider inventory and refresh status commands', async () => {
  const run = vi
    .fn()
    .mockResolvedValueOnce(JSON.stringify([provider]))
    .mockResolvedValueOnce(JSON.stringify({ credentials: [credential] }));
  await new OpenShellRuntimeManager(config, run).verifySubscriptionSignIn(
    new AbortController().signal,
  );
  expect(run.mock.calls.map(([args]) => args)).toEqual([
    [
      'provider',
      '--gateway',
      'test',
      '--workspace',
      'mitzo',
      'list',
      '--output',
      'json',
      '--limit',
      '100',
    ],
    [
      'provider',
      '--gateway',
      'test',
      '--workspace',
      'mitzo',
      'refresh',
      'status',
      'personal',
      '--output',
      'json',
    ],
  ]);
});
it.each([
  { provider_id: 'other' },
  { refresh_generation_id: 'rotated' },
  { expires_at_ms: Date.now() - 1 },
  { status: 'revoked' },
  { credential_key: 'OTHER_KEY' },
])('rejects invalid credential evidence %o', async (change) => {
  const run = vi
    .fn()
    .mockResolvedValueOnce(JSON.stringify([provider]))
    .mockResolvedValueOnce(JSON.stringify({ credentials: [{ ...credential, ...change }] }));
  await expect(
    new OpenShellRuntimeManager(config, run).verifySubscriptionSignIn(new AbortController().signal),
  ).rejects.toThrow('grant');
  expect(run).toHaveBeenCalledTimes(2);
});
it.each([{ id: 'other' }, { workspace: 'other' }, { type: 'codex' }])(
  'rejects provider binding drift %o',
  async (change) => {
    const run = vi.fn().mockResolvedValueOnce(JSON.stringify([{ ...provider, ...change }]));
    await expect(
      new OpenShellRuntimeManager(config, run).verifySubscriptionSignIn(
        new AbortController().signal,
      ),
    ).rejects.toThrow('selected account');
    expect(run).toHaveBeenCalledTimes(1);
  },
);
it('rejects ambiguous providers and never executes after cancellation', async () => {
  const run = vi.fn().mockResolvedValue(JSON.stringify([provider, provider]));
  await expect(
    new OpenShellRuntimeManager(config, run).verifySubscriptionSignIn(new AbortController().signal),
  ).rejects.toThrow();
  const signal = AbortSignal.abort();
  await expect(
    new OpenShellRuntimeManager(config, run).verifySubscriptionSignIn(signal),
  ).rejects.toThrow();
  expect(run).toHaveBeenCalledTimes(1);
});
