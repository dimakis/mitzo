import { afterEach, expect, it, vi } from 'vitest';
import { AccountProfiles } from '../account-profiles.js';
import { credentials } from '../credentials.js';
import { KeychainRotationCredentials } from '../keychain-rotation-credentials.js';

let sequence = 0;
const profile = () => ({
  id: `api-discovery-${++sequence}`,
  label: 'Synthetic work API',
  provider: 'openai' as const,
  credentialRef: { provider: 'keychain', service: 'synthetic-work', account: 'api-key' },
  models: [{ id: 'gpt-5.6-sol', label: 'Configured Sol' }],
});
const catalog = (...ids: string[]) =>
  new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('refreshes existing API accounts from their own key, caches across profile reloads, and honors forced refresh', async () => {
  const configured = profile();
  const resolve = vi.spyOn(credentials, 'resolve').mockResolvedValue('SYNTHETIC_WORK_KEY');
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      catalog('gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.4-nano', 'gpt-image-2'),
    )
    .mockResolvedValueOnce(catalog('gpt-6-luna'));
  vi.stubGlobal('fetch', request);
  const profiles = new AccountProfiles([configured]);
  await profiles.refresh();
  expect(resolve).toHaveBeenCalledWith(configured.credentialRef);
  expect(request).toHaveBeenCalledWith(
    'https://api.openai.com/v1/models',
    expect.objectContaining({
      method: 'GET',
      redirect: 'error',
      headers: { Authorization: 'Bearer SYNTHETIC_WORK_KEY' },
    }),
  );
  expect(profiles.catalog()[0].models.map((m) => m.id)).toEqual([
    'gpt-6.1-sol',
    'gpt-6-sol',
    'gpt-6-luna',
  ]);
  const binding = profiles.resolve(configured.id, 'gpt-6.1-sol');
  expect(binding.provider).toBe('openai');
  expect(() => profiles.resolve(configured.id, 'gpt-5.6-sol')).toThrow(/unavailable/);
  expect(JSON.stringify(profiles.catalog())).not.toMatch(/SYNTHETIC_WORK_KEY|synthetic-work/);
  const reloaded = new AccountProfiles([configured]);
  await reloaded.refresh();
  expect(request).toHaveBeenCalledOnce();
  await reloaded.refresh(true);
  expect(request).toHaveBeenCalledTimes(2);
  expect(reloaded.catalog()[0].models.map((m) => m.id)).toEqual(['gpt-6-luna']);
});

it('does not require Luna availability for ordinary metadata refresh and keeps configured labels and capabilities', async () => {
  const configured = profile();
  vi.spyOn(credentials, 'resolve').mockResolvedValue('SYNTHETIC_WORK_KEY');
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(catalog('gpt-5.6-sol')));
  const profiles = new AccountProfiles([configured]);
  await profiles.refresh(true);
  expect(profiles.catalog()[0].modelDiscovery.stale).toBe(false);
  expect(profiles.catalog()[0].models).toEqual(configured.models);
});

it('keeps account caches separate and retains the last successful catalog on discovery failure', async () => {
  const first = profile();
  const second = profile();
  second.credentialRef = { ...second.credentialRef, service: 'synthetic-other' };
  vi.spyOn(credentials, 'resolve').mockImplementation(async (ref) => ref.service);
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      if ((init?.headers as Record<string, string>).Authorization === 'Bearer synthetic-work')
        return catalog('gpt-6-luna');
      return new Response('SYNTHETIC_PRIVATE_FAILURE', { status: 403 });
    }),
  );
  const profiles = new AccountProfiles([first, second]);
  await profiles.refresh();
  expect(profiles.catalog()[0].models.map((m) => m.id)).toEqual(['gpt-6-luna']);
  expect(profiles.catalog()[1].models).toEqual(second.models);
  expect(profiles.catalog()[1].modelDiscovery.stale).toBe(true);
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>().mockRejectedValue(new Error('SYNTHETIC_PRIVATE_FAILURE')),
  );
  await profiles.refresh(true);
  expect(profiles.catalog()[0].models.map((m) => m.id)).toEqual(['gpt-6-luna']);
  expect(profiles.catalog()[0].modelDiscovery.stale).toBe(true);
  expect(JSON.stringify(profiles.catalog())).not.toContain('SYNTHETIC_PRIVATE_FAILURE');
});

it('bounds credential discovery and never tries inherited credentials or another account', async () => {
  const resolve = vi.spyOn(credentials, 'resolve').mockImplementation(() => new Promise(() => {}));
  const request = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', request);
  const configured = profile();
  const profiles = new AccountProfiles([configured], { modelDiscoveryTimeoutMs: 5 });
  await profiles.refresh(true);
  expect(profiles.catalog()[0].modelDiscovery.stale).toBe(true);
  expect(profiles.catalog()[0].models).toEqual(configured.models);
  expect(resolve).toHaveBeenCalledOnce();
  expect(request).not.toHaveBeenCalled();
});

it('does not replace a useful catalog with an empty, malformed, truncated, or unsupported response', async () => {
  vi.spyOn(credentials, 'resolve').mockResolvedValue('SYNTHETIC_WORK_KEY');
  for (const response of [
    catalog(),
    catalog('gpt-image-2'),
    new Response('not json'),
    new Response(JSON.stringify({ data: [{ id: 'gpt-6-luna' }], has_more: true })),
  ]) {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(response));
    const configured = profile();
    const profiles = new AccountProfiles([configured]);
    await profiles.refresh(true);
    expect(profiles.catalog()[0].models).toEqual(configured.models);
    expect(profiles.catalog()[0].modelDiscovery.stale).toBe(true);
  }
});

it('bounds the metadata response, deduplicates simultaneous refreshes, and restores normal refresh after timeout', async () => {
  const resolve = vi.spyOn(credentials, 'resolve').mockResolvedValue('SYNTHETIC_WORK_KEY');
  const request = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
  vi.stubGlobal('fetch', request);
  const configured = profile();
  const profiles = new AccountProfiles([configured], { modelDiscoveryTimeoutMs: 5 });
  await Promise.all([profiles.refresh(), profiles.refresh(true)]);
  expect(request).toHaveBeenCalledOnce();
  expect(resolve).toHaveBeenCalledOnce();
  expect(profiles.catalog()[0].modelDiscovery.stale).toBe(true);
  request.mockResolvedValue(catalog('gpt-6-luna'));
  await profiles.refresh();
  expect(request).toHaveBeenCalledTimes(2);
  expect(profiles.catalog()[0].modelDiscovery.stale).toBe(false);
  expect(profiles.catalog()[0].models.map((model) => model.id)).toEqual(['gpt-6-luna']);
});

it('uses the configured signed Keychain helper for protected and enrolled keys', async () => {
  vi.stubEnv('MITZO_KEYCHAIN_HELPER', '/synthetic/signed-helper');
  const raw = vi
    .spyOn(credentials, 'resolve')
    .mockRejectedValue(new Error('raw Keychain read forbidden'));
  const signed = vi.spyOn(KeychainRotationCredentials.prototype, 'read').mockResolvedValue({
    value: 'SYNTHETIC_SIGNED_KEY',
    version: null,
    managed: false,
  });
  const request = vi.fn<typeof fetch>().mockResolvedValue(catalog('gpt-6-luna', 'gpt-6.1-sol'));
  vi.stubGlobal('fetch', request);
  const configured = profile();
  const profiles = new AccountProfiles([configured]);
  await profiles.refresh();
  expect(signed).toHaveBeenCalledWith(configured.credentialRef, expect.any(AbortSignal));
  expect(raw).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledWith(
    'https://api.openai.com/v1/models',
    expect.objectContaining({
      headers: { Authorization: 'Bearer SYNTHETIC_SIGNED_KEY' },
    }),
  );
  expect(profiles.catalog()[0].models.map((model) => model.id)).toEqual([
    'gpt-6.1-sol',
    'gpt-6-luna',
  ]);
});

it('never falls back to an interpreter credential read when the signed helper fails', async () => {
  vi.stubEnv('MITZO_KEYCHAIN_HELPER', '/synthetic/signed-helper');
  vi.spyOn(KeychainRotationCredentials.prototype, 'read').mockRejectedValue(new Error('locked'));
  const raw = vi.spyOn(credentials, 'resolve').mockResolvedValue('SYNTHETIC_UNAUTHORIZED_FALLBACK');
  const request = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', request);
  const configured = profile();
  const profiles = new AccountProfiles([configured]);
  await profiles.refresh();
  expect(raw).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
  expect(profiles.catalog()[0].models).toEqual(configured.models);
  expect(profiles.catalog()[0].modelDiscovery.stale).toBe(true);
});
