import { afterEach, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  createCredentialConnectionsRuntime,
  keychainConnectionConfig,
} from '../credential-connections-runtime.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, lstatSync: vi.fn(actual.lstatSync) };
});
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
const temporaryDirectories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(lstatSync).mockImplementation(actualFs.lstatSync);
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function runtimeFixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'mitzo-credential-runtime-'));
  temporaryDirectories.push(root);
  const directory = join(root, 'metadata');
  return {
    root,
    directory,
    config: { directory, helper: '/private/helper', requirement: 'fixture', namespace: 'fixture' },
  };
}

it('creates owner-only metadata, database and SQLite sidecar files', () => {
  const { directory, config } = runtimeFixture();
  const { store } = createCredentialConnectionsRuntime(config);
  try {
    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    for (const name of ['connections.db', 'connections.db-wal', 'connections.db-shm']) {
      expect(lstatSync(join(directory, name)).mode & 0o777).toBe(0o600);
      expect(lstatSync(join(directory, name)).uid).toBe(process.getuid!());
    }
  } finally {
    store.close();
  }
});

it.each([0o755, 0o770])(
  'rejects an existing nonprivate metadata directory (%s) before database creation',
  (mode) => {
    const { directory, config } = runtimeFixture();
    mkdirSync(directory, { mode });
    chmodSync(directory, mode);
    expect(() => createCredentialConnectionsRuntime(config)).toThrow('private');
    expect(existsSync(join(directory, 'connections.db'))).toBe(false);
  },
);

it('rejects a symlink metadata directory before accessing its target', () => {
  const { root, directory, config } = runtimeFixture();
  const target = join(root, 'target');
  mkdirSync(target, { mode: 0o700 });
  symlinkSync(target, directory);
  expect(() => createCredentialConnectionsRuntime(config)).toThrow('private');
  expect(existsSync(join(target, 'connections.db'))).toBe(false);
});

it('rejects metadata owned by another user before database creation', () => {
  const { directory, config } = runtimeFixture();
  mkdirSync(directory, { mode: 0o700 });
  vi.spyOn(process, 'getuid').mockReturnValue(process.getuid!() + 1);
  expect(() => createCredentialConnectionsRuntime(config)).toThrow('owned');
  expect(existsSync(join(directory, 'connections.db'))).toBe(false);
});

it.each(['connections.db', 'connections.db-wal', 'connections.db-shm', 'connections.db-journal'])(
  'rejects nonprivate existing %s before SQLite reads it',
  (name) => {
    const { directory, config } = runtimeFixture();
    mkdirSync(directory, { mode: 0o700 });
    const path = join(directory, name);
    writeFileSync(path, 'untouched fixture', { mode: 0o644 });
    chmodSync(path, 0o644);
    expect(() => createCredentialConnectionsRuntime(config)).toThrow('private');
    expect(readFileSync(path, 'utf8')).toBe('untouched fixture');
  },
);

it.each(['connections.db', 'connections.db-wal', 'connections.db-shm', 'connections.db-journal'])(
  'rejects a symlink %s before SQLite reads its target',
  (name) => {
    const { root, directory, config } = runtimeFixture();
    mkdirSync(directory, { mode: 0o700 });
    const target = join(root, 'target');
    writeFileSync(target, 'untouched fixture', { mode: 0o600 });
    symlinkSync(target, join(directory, name));
    expect(() => createCredentialConnectionsRuntime(config)).toThrow('private');
    expect(readFileSync(target, 'utf8')).toBe('untouched fixture');
  },
);

it.each(['connections.db', 'connections.db-wal', 'connections.db-shm', 'connections.db-journal'])(
  'rejects another user owning %s before SQLite reads it',
  (name) => {
    const { directory, config } = runtimeFixture();
    mkdirSync(directory, { mode: 0o700 });
    const path = join(directory, name);
    writeFileSync(path, 'untouched fixture', { mode: 0o600 });
    vi.mocked(lstatSync).mockImplementation(((candidate: string) => {
      const info = actualFs.lstatSync(candidate);
      if (candidate === path) info.uid += 1;
      return info;
    }) as typeof lstatSync);
    expect(() => createCredentialConnectionsRuntime(config)).toThrow('owned');
    expect(readFileSync(path, 'utf8')).toBe('untouched fixture');
  },
);

it('reopens an existing private metadata database', () => {
  const { config } = runtimeFixture();
  createCredentialConnectionsRuntime(config).store.close();
  const { store } = createCredentialConnectionsRuntime(config);
  try {
    expect(store.list()).toEqual([]);
  } finally {
    store.close();
  }
});

it('accepts root-controlled temporary directory aliases and uses their canonical location', () => {
  const { root, directory, config } = runtimeFixture();
  const alias = join(tmpdir(), basename(root), 'metadata');
  const { store } = createCredentialConnectionsRuntime({ ...config, directory: alias });
  try {
    expect(realpathSync(alias)).toBe(directory);
    expect(lstatSync(join(directory, 'connections.db')).mode & 0o777).toBe(0o600);
  } finally {
    store.close();
  }
});
it('is opt-in, macOS-only, and requires an absolute helper path and trusted signing team', () => {
  expect(keychainConnectionConfig({}, 'darwin')).toBeNull();
  expect(() =>
    keychainConnectionConfig({ MITZO_KEYCHAIN_CONNECTIONS_ENABLED: '1' }, 'darwin'),
  ).toThrow();
  const env = {
    MITZO_KEYCHAIN_CONNECTIONS_ENABLED: '1',
    MITZO_KEYCHAIN_HELPER: '/private/helper',
    MITZO_KEYCHAIN_TEAM_ID: 'ABCDEF1234',
  };
  expect(() => keychainConnectionConfig(env, 'linux')).toThrow('macOS');
  expect(keychainConnectionConfig(env, 'darwin')?.requirement).toContain('anchor apple generic');
  expect(keychainConnectionConfig(env, 'darwin')?.requirement).toContain('ABCDEF1234');
  expect(() =>
    keychainConnectionConfig({ ...env, MITZO_KEYCHAIN_HELPER: 'relative' }, 'darwin'),
  ).toThrow();
  expect(() =>
    keychainConnectionConfig({ ...env, MITZO_KEYCHAIN_TEAM_ID: '-' }, 'darwin'),
  ).toThrow();
});

it('isolates default metadata by validated controller namespace', () => {
  const env = {
    MITZO_KEYCHAIN_CONNECTIONS_ENABLED: '1',
    MITZO_KEYCHAIN_HELPER: '/private/helper',
    MITZO_KEYCHAIN_TEAM_ID: 'ABCDEF1234',
  };
  const production = keychainConnectionConfig(env, 'darwin')!;
  const staging = keychainConnectionConfig(
    { ...env, MITZO_KEYCHAIN_CONNECTIONS_NAMESPACE: 'staging' },
    'darwin',
  )!;
  expect(production.namespace).toBe('default');
  expect(staging.namespace).toBe('staging');
  expect(staging.directory).not.toBe(production.directory);
  expect(staging.directory).toMatch(/credential-connections\/staging$/);
  for (const namespace of [
    '../production',
    '/private/path',
    'UPPER',
    'staging\n',
    '',
    'a'.repeat(65),
  ]) {
    expect(() =>
      keychainConnectionConfig(
        { ...env, MITZO_KEYCHAIN_CONNECTIONS_NAMESPACE: namespace },
        'darwin',
      ),
    ).toThrow('namespace');
  }
});

it('rejects a symlink ancestor before creating metadata in its target', () => {
  const { root, config } = runtimeFixture();
  const target = join(root, 'target');
  const ancestor = join(root, 'alias');
  mkdirSync(target, { mode: 0o700 });
  symlinkSync(target, ancestor);
  expect(() =>
    createCredentialConnectionsRuntime({ ...config, directory: join(ancestor, 'metadata') }),
  ).toThrow('private');
  expect(existsSync(join(target, 'metadata'))).toBe(false);
});

it.each([0o770, 0o777])(
  'rejects a writable metadata parent (%s) before creating metadata',
  (mode) => {
    const { root, directory, config } = runtimeFixture();
    chmodSync(root, mode);
    expect(() => createCredentialConnectionsRuntime(config)).toThrow('private');
    expect(existsSync(directory)).toBe(false);
  },
);

it('rejects a foreign-owned metadata parent before creating metadata', () => {
  const { root, directory, config } = runtimeFixture();
  vi.mocked(lstatSync).mockImplementation(((candidate: string) => {
    const info = actualFs.lstatSync(candidate);
    if (candidate === root) info.uid = process.getuid!() + 1;
    return info;
  }) as typeof lstatSync);
  expect(() => createCredentialConnectionsRuntime(config)).toThrow('owned');
  expect(existsSync(directory)).toBe(false);
});
