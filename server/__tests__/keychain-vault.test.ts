import { expect, it, vi } from 'vitest';
import { MacKeychainVault, KeychainUnavailableError } from '../keychain-vault.js';

const controller = {
  authorization: async () => 'controller-token',
  enroll: async () => {},
  forget: async () => {},
};

it('uses JSON stdin for secrets, verifies the signed helper, and never puts a secret in argv', async () => {
  const run = vi.fn<(file: string, input: unknown) => Promise<string>>(async () =>
    JSON.stringify({
      ok: true,
      service: 'mitzo.connection.id',
      account: 'credential',
      persistentRef: 'aXRlbS1pZA==',
    }),
  );
  const verify = vi.fn(async () => {});
  const vault = new MacKeychainVault(
    '/trusted/helper',
    'signed-requirement',
    run,
    verify,
    controller,
  );
  expect(await vault.save('id', 'private-token')).toEqual({
    service: 'mitzo.connection.id',
    account: 'credential',
    persistentRef: 'aXRlbS1pZA==',
  });
  expect(verify).toHaveBeenCalledWith('/trusted/helper', 'signed-requirement');
  expect(run).toHaveBeenCalledWith('/trusted/helper', {
    authorization: 'controller-token',
    operation: 'save',
    service: 'mitzo.connection.id',
    account: 'credential',
    secret: 'private-token',
  });
});
it('fails closed on signing errors without launching the helper', async () => {
  const run = vi.fn();
  const verify = vi.fn(async () => {
    throw new Error('private signing error');
  });
  const vault = new MacKeychainVault('/trusted/helper', 'requirement', run, verify, controller);
  await expect(vault.read({ service: 'service', account: 'user' })).rejects.toThrow(
    /^Apple Keychain helper is unavailable$/,
  );
  expect(run).not.toHaveBeenCalled();
});
it('returns actionable locked-keychain errors and strips all other error details', async () => {
  const run = vi.fn<(file: string, input: unknown) => Promise<string>>(async () =>
    JSON.stringify({ ok: false, code: 'unlock_on_mac', secret: 'private-token' }),
  );
  const vault = new MacKeychainVault(
    '/trusted/helper',
    'requirement',
    run,
    async () => {},
    controller,
  );
  await expect(vault.read({ service: 'service', account: 'user' })).rejects.toBeInstanceOf(
    KeychainUnavailableError,
  );
  run.mockResolvedValueOnce(JSON.stringify({ ok: false, code: 'private-token' }));
  await expect(vault.read({ service: 'service', account: 'user' })).rejects.toThrow(
    /^Apple Keychain credential is unavailable$/,
  );
});
it('links exact items without exposing their secret or supporting enumeration', async () => {
  const run = vi.fn<(file: string, input: unknown) => Promise<string>>(async () =>
    JSON.stringify({
      ok: true,
      service: 'existing',
      account: 'alice',
      secret: 'must-not-return',
      persistentRef: 'aXRlbS1pZA==',
    }),
  );
  const vault = new MacKeychainVault(
    '/trusted/helper',
    'requirement',
    run,
    async () => {},
    controller,
  );
  expect(await vault.link({ service: 'existing', account: 'alice' })).toEqual({
    service: 'existing',
    account: 'alice',
    persistentRef: 'aXRlbS1pZA==',
  });
  expect(run.mock.calls[0][1]).toEqual({
    authorization: 'controller-token',
    operation: 'link',
    service: 'existing',
    account: 'alice',
  });
});

it('pins the persistent Keychain item identity rather than choosing another item with matching coordinates', async () => {
  const run = vi.fn<(file: string, input: unknown) => Promise<string>>(async () =>
    JSON.stringify({ ok: true, persistentRef: 'aXRlbS1pZA==' }),
  );
  const vault = new MacKeychainVault(
    '/trusted/helper',
    'requirement',
    run,
    async () => {},
    controller,
  );
  const ref = await vault.link({ service: 'existing', account: 'alice' });
  expect(ref.persistentRef).toBe('aXRlbS1pZA==');
  run.mockResolvedValueOnce(JSON.stringify({ ok: true, secret: 'secret' }));
  await vault.read(ref);
  expect(run.mock.calls[1][1]).toEqual({
    authorization: 'controller-token',
    operation: 'read',
    service: 'existing',
    account: 'alice',
    persistentRef: 'aXRlbS1pZA==',
  });
});

it('rejects malformed helper success responses with sanitized errors', async () => {
  const run = vi.fn(async () => JSON.stringify({ ok: true, persistentRef: 'private-secret!' }));
  const vault = new MacKeychainVault(
    '/trusted/helper',
    'requirement',
    run,
    async () => {},
    controller,
  );
  await expect(vault.link({ service: 'existing', account: 'alice' })).rejects.toThrow(
    /^Apple Keychain credential is unavailable$/,
  );
  run.mockResolvedValueOnce(JSON.stringify({ ok: true, secret: { private: 'secret' } }));
  await expect(
    vault.read({ service: 'existing', account: 'alice', persistentRef: 'aXRlbS1pZA==' }),
  ).rejects.toThrow(/^Apple Keychain credential is unavailable$/);
  run.mockResolvedValueOnce(JSON.stringify({ ok: 'yes', secret: 'secret' }));
  await expect(
    vault.read({ service: 'existing', account: 'alice', persistentRef: 'aXRlbS1pZA==' }),
  ).rejects.toThrow(/^Apple Keychain credential is unavailable$/);
});

it('passes the controller namespace to the native helper', async () => {
  const run = vi.fn<(file: string, input: unknown) => Promise<string>>(async () =>
    JSON.stringify({ ok: true, secret: 'fixture' }),
  );
  const vault = new MacKeychainVault('/trusted/helper', 'requirement', run, async () => {}, {
    ...controller,
    namespace: 'staging',
  });
  await vault.read({ service: 'existing', account: 'alice', persistentRef: 'aXRlbS1pZA==' });
  expect(run.mock.calls[0][1]).toMatchObject({ namespace: 'staging' });
});

it('asks for re-enrollment when a pinned credential changed or disappeared', () => {
  expect(new KeychainUnavailableError('item_missing').message).toBe(
    'Apple Keychain item changed or is missing; re-enroll the connection',
  );
});
