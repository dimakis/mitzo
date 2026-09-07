import { expect, it, vi } from 'vitest';
import { CredentialResolver, KeychainCredentialProvider } from '../credentials.js';

it('resolves a reference through the selected provider without fallback', async () => {
  const resolve = vi.fn(async () => 'private-test-value');
  const resolver = new CredentialResolver({ custom: { resolve } });
  expect(await resolver.resolve({ provider: 'custom', service: 'mitzo', account: 'work' })).toBe(
    'private-test-value',
  );
  expect(resolve).toHaveBeenCalledWith({ provider: 'custom', service: 'mitzo', account: 'work' });
  await expect(
    resolver.resolve({ provider: 'missing', service: 'mitzo', account: 'work' }),
  ).rejects.toThrow('Credential provider is unavailable');
  expect(resolve).toHaveBeenCalledTimes(1);
});

it('redacts provider errors and rejects empty secrets', async () => {
  for (const resolve of [
    async () => {
      throw new Error('secret leaked here');
    },
    async () => '  ',
  ]) {
    const resolver = new CredentialResolver({ test: { resolve } });
    await expect(
      resolver.resolve({ provider: 'test', service: 'mitzo', account: 'work' }),
    ).rejects.toThrow(/^Credential unavailable. Check the configured secret store\.$/);
  }
});

it('retrieves a Keychain item using only non-secret identifiers as arguments', async () => {
  const run = vi.fn(async () => 'private-test-value\n');
  const provider = new KeychainCredentialProvider(run);
  expect(await provider.resolve({ provider: 'keychain', service: 'mitzo', account: 'work' })).toBe(
    'private-test-value',
  );
  expect(run).toHaveBeenCalledWith('/usr/bin/security', [
    'find-generic-password',
    '-s',
    'mitzo',
    '-a',
    'work',
    '-w',
  ]);
});
