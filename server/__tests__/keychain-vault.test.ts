import { expect, it, vi } from 'vitest';
import {
  linkSync,
  symlinkSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareKeychainHelper } from '../keychain-helper-authority.js';
const fixtureHelper = (file: string) => ({ file, dispose() {} });
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
    fixtureHelper,
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
  const vault = new MacKeychainVault(
    '/trusted/helper',
    'requirement',
    run,
    verify,
    controller,
    fixtureHelper,
  );
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
    fixtureHelper,
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
    fixtureHelper,
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
    fixtureHelper,
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
    fixtureHelper,
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
  const vault = new MacKeychainVault(
    '/trusted/helper',
    'requirement',
    run,
    async () => {},
    {
      ...controller,
      namespace: 'staging',
    },
    fixtureHelper,
  );
  await vault.read({ service: 'existing', account: 'alice', persistentRef: 'aXRlbS1pZA==' });
  expect(run.mock.calls[0][1]).toMatchObject({ namespace: 'staging' });
});

it('asks for re-enrollment when a pinned credential changed or disappeared', () => {
  expect(new KeychainUnavailableError('item_missing').message).toBe(
    'Apple Keychain item changed or is missing; re-enroll the connection',
  );
});

it('executes the verified private copy even when codesign verification swaps the configured helper', async () => {
  const root = mkdtempSync(join(tmpdir(), 'keychain-helper-pin-'));
  const source = join(root, 'helper');
  const storage = join(root, 'private');
  mkdirSync(storage, { mode: 0o700 });
  writeFileSync(source, 'signed fixture', { mode: 0o500 });
  const verify = vi.fn(async (file: string) => {
    expect(file).not.toBe(source);
    expect(readFileSync(file, 'utf8')).toBe('signed fixture');
    rmSync(source);
    writeFileSync(source, 'replacement', { mode: 0o500 });
  });
  let executable = '';
  const run = vi.fn(async (file: string) => {
    executable = file;
    expect(readFileSync(file, 'utf8')).toBe('signed fixture');
    return JSON.stringify({ ok: true, secret: 'fixture' });
  });
  try {
    const vault = new MacKeychainVault(source, 'requirement', run, verify, controller, (file) =>
      prepareKeychainHelper(file, storage),
    );
    await expect(vault.read({ service: 'fixture', account: 'fixture' })).resolves.toBe('fixture');
    expect(() => readFileSync(executable)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('rejects a helper in an untrusted writable ancestor before obtaining authorization', async () => {
  const root = mkdtempSync(join(tmpdir(), 'keychain-helper-unsafe-'));
  const source = join(root, 'helper');
  writeFileSync(source, 'fixture', { mode: 0o500 });
  chmodSync(root, 0o777);
  const authorization = vi.fn(async () => 'fixture-token');
  const run = vi.fn();
  try {
    const vault = new MacKeychainVault(source, 'requirement', run, async () => {}, {
      ...controller,
      authorization,
    });
    await expect(vault.read({ service: 'fixture', account: 'fixture' })).rejects.toThrow(
      'Apple Keychain helper is unavailable',
    );
    expect(authorization).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('cleans the private executable after a signing failure without requesting a capability', async () => {
  const root = mkdtempSync(join(tmpdir(), 'keychain-helper-signing-'));
  const source = join(root, 'helper');
  const storage = join(root, 'private');
  writeFileSync(source, 'fixture', { mode: 0o500 });
  let executable = '';
  const authorization = vi.fn(async () => 'fixture');
  try {
    const vault = new MacKeychainVault(
      source,
      'requirement',
      vi.fn(),
      async (file) => {
        executable = file;
        throw new Error('private signing diagnostics');
      },
      { ...controller, authorization },
      (file) => prepareKeychainHelper(file, storage),
    );
    await expect(vault.read({ service: 'fixture', account: 'fixture' })).rejects.toThrow(
      /^Apple Keychain helper is unavailable$/,
    );
    expect(authorization).not.toHaveBeenCalled();
    expect(() => readFileSync(executable)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.runIf(process.platform === 'darwin')(
  'verifies and executes a copied signed Mach-O fixture on macOS',
  async () => {
    const { execFileSync } = await import('node:child_process');
    const root = mkdtempSync(join(tmpdir(), 'keychain-helper-native-'));
    const source = join(root, 'helper');
    const storage = join(root, 'private');
    const code = join(root, 'fixture.c');
    writeFileSync(
      code,
      '#include <stdio.h>\nint main(void) { char input[4096]; if (!fgets(input, sizeof(input), stdin)) return 1; puts("{\\"ok\\":true,\\"secret\\":\\"synthetic-fixture\\"}"); return 0; }\n',
    );
    try {
      execFileSync('/usr/bin/clang', [code, '-o', source], { timeout: 30_000 });
      execFileSync(
        '/usr/bin/codesign',
        ['--force', '--sign', '-', '--identifier', 'com.mitzo.fixture', source],
        { timeout: 10_000 },
      );
      const vault = new MacKeychainVault(
        source,
        'identifier "com.mitzo.fixture"',
        undefined,
        undefined,
        {
          ...controller,
          authorization: async () => {
            // Replacement after verification cannot change the private executable.
            rmSync(source);
            writeFileSync(source, 'untrusted replacement', { mode: 0o500 });
            return 'synthetic-controller-token';
          },
        },
        (file) => prepareKeychainHelper(file, storage),
      );
      await expect(vault.read({ service: 'fixture', account: 'fixture' })).resolves.toBe(
        'synthetic-fixture',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it.each(['symlink', 'hardlink', 'writable', 'directory'])(
  'rejects a %s source instead of copying it',
  (kind) => {
    const root = mkdtempSync(join(tmpdir(), 'keychain-helper-type-'));
    const source = join(root, 'helper');
    const target = join(root, 'target');
    writeFileSync(target, 'fixture', { mode: 0o500 });
    try {
      if (kind === 'symlink') symlinkSync(target, source);
      else if (kind === 'hardlink') linkSync(target, source);
      else if (kind === 'directory') mkdirSync(source, { mode: 0o700 });
      else {
        writeFileSync(source, 'fixture', { mode: 0o777 });
        chmodSync(source, 0o777);
      }
      expect(() => prepareKeychainHelper(source, join(root, 'private'))).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it('rejects controller executable storage in writable ancestry', () => {
  const root = mkdtempSync(join(tmpdir(), 'keychain-helper-storage-'));
  const source = join(root, 'helper');
  const unsafe = join(root, 'unsafe');
  writeFileSync(source, 'fixture', { mode: 0o500 });
  mkdirSync(unsafe, { mode: 0o777 });
  chmodSync(unsafe, 0o777);
  try {
    expect(() => prepareKeychainHelper(source, join(unsafe, 'private'))).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
