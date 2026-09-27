import { expect, it } from 'vitest';
import { custodianAppEnvironment } from '../symposium-custodian-launch.js';
it('passes explicit app configuration without provider secrets or a second owned-host bootstrap', () => {
  const env = custodianAppEnvironment({
    PATH: '/usr/bin',
    HOME: '/test/home',
    AUTH_PASSPHRASE: 'test-app-passphrase',
    AUTH_SECRET: 'test-app-secret',
    REPO_PATH: '/test/repo',
    PORT: '4000',
    MITZO_SYMPOSIUM_OWNED_HOST_CONFIG: '/private/host.json',
    OPENAI_API_KEY: 'must-not-copy',
    GOOGLE_APPLICATION_CREDENTIALS: '/private/adc.json',
    SYMPOSIUM_NATIVE_ATTEMPT_DIR: '/private/claims',
    NODE_OPTIONS: '--import unsafe',
    MITZO_CODEX_PRIVATE_DIR: '/private/native-ledger',
  });
  expect(env).toMatchObject({
    AUTH_PASSPHRASE: 'test-app-passphrase',
    AUTH_SECRET: 'test-app-secret',
    PORT: '4000',
    MITZO_SYMPOSIUM_CUSTODIAN_CONTROLLER: '1',
    DOTENV_CONFIG_PATH: '/dev/null',
    MITZO_CODEX_PRIVATE_DIR: '/private/native-ledger',
  });
  for (const key of [
    'MITZO_SYMPOSIUM_OWNED_HOST_CONFIG',
    'OPENAI_API_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'SYMPOSIUM_NATIVE_ATTEMPT_DIR',
    'NODE_OPTIONS',
  ])
    expect(env[key]).toBeUndefined();
});
