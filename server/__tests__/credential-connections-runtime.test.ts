import { expect, it } from 'vitest';
import { keychainConnectionConfig } from '../credential-connections-runtime.js';
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
