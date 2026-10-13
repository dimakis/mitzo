import { afterEach, expect, it, vi } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FrozenHostCodexLogin } from '../frozen-host-codex-login.js';

const roots: string[] = [];
const auth = JSON.stringify({
  tokens: {
    access_token: 'fixture-access',
    refresh_token: 'fixture-refresh',
    id_token: 'fixture-id',
    account_id: 'fixture-account',
  },
  OPENAI_API_KEY: null,
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'frozen-codex-test-')));
  roots.push(root);
  const source = join(root, 'source'),
    privateRoot = join(root, 'private');
  mkdirSync(source, { mode: 0o700 });
  mkdirSync(privateRoot, { mode: 0o700 });
  writeFileSync(join(source, 'auth.json'), auth, { mode: 0o600 });
  writeFileSync(join(source, 'config.toml'), 'model_provider = "private-routing"');
  const profile = {
    accountId: 'personal',
    accountLabel: 'Personal',
    credentialRef: source,
    email: 'person@example.test',
    planType: 'plus',
    model: 'fixture-model',
  };
  const client = {
    initialize: vi.fn(async () => {}),
    request: vi.fn(async () => ({
      account: { type: 'chatgpt', email: profile.email, planType: profile.planType },
    })),
    close: vi.fn(),
  };
  return { root, source, privateRoot, profile, client };
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

it('freezes file-backed login only and verifies the actual client reused for admission', async () => {
  const f = fixture();
  const login = FrozenHostCodexLogin.capture(f.profile, { privateRoot: f.privateRoot });
  const launch = vi.fn(() => f.client);
  const lease = await login.connect(launch);
  expect(() => lease.assertCurrentSync()).not.toThrow();
  expect(launch).toHaveBeenCalledWith(login.privateHome);
  expect(lease.client).toBe(f.client);
  expect(readFileSync(join(login.privateHome, 'auth.json'), 'utf8')).toBe(auth);
  expect(() => readFileSync(join(login.privateHome, 'config.toml'))).toThrow();
  expect(statSync(login.privateHome).mode & 0o777).toBe(0o700);
  expect(statSync(join(login.privateHome, 'auth.json')).mode & 0o777).toBe(0o600);
  await lease.assertCurrent();
  expect(f.client.initialize).toHaveBeenCalledTimes(1);
  expect(f.client.request.mock.calls).toEqual([
    ['account/read', { refreshToken: false }],
    ['account/read', { refreshToken: false }],
  ]);
  lease.close();
  expect(() => lease.assertCurrentSync()).toThrow('Host Codex login unavailable');
  expect(f.client.close).toHaveBeenCalledTimes(1);
  expect(readFileSync(join(login.privateHome, 'auth.json'), 'utf8')).toBe(auth);
  await expect(lease.assertCurrent()).rejects.toThrow('Host Codex login unavailable');
  await expect(login.connect(launch)).rejects.toThrow('Host Codex login unavailable');
  expect(launch).toHaveBeenCalledTimes(1);
});

it.each(['content', 'auth-replacement', 'root-replacement', 'permissions'] as const)(
  'blocks source %s mutation before launch and retains uncertainty',
  async (kind) => {
    const f = fixture();
    const login = FrozenHostCodexLogin.capture(f.profile, { privateRoot: f.privateRoot });
    if (kind === 'content')
      writeFileSync(join(f.source, 'auth.json'), auth.replace('fixture-access', 'new-access'));
    if (kind === 'auth-replacement') {
      renameSync(join(f.source, 'auth.json'), join(f.source, 'old-auth'));
      writeFileSync(join(f.source, 'auth.json'), auth, { mode: 0o600 });
    }
    if (kind === 'root-replacement') {
      renameSync(f.source, join(f.root, 'old-source'));
      mkdirSync(f.source, { mode: 0o700 });
      writeFileSync(join(f.source, 'auth.json'), auth, { mode: 0o600 });
    }
    if (kind === 'permissions') chmodSync(join(f.source, 'auth.json'), 0o644);
    const launch = vi.fn(() => f.client);
    await expect(login.connect(launch)).rejects.toThrow('Host Codex login unavailable');
    expect(launch).not.toHaveBeenCalled();
    expect(readFileSync(join(login.privateHome, 'auth.json'), 'utf8')).toBe(auth);
  },
);

it('rechecks source revocation and account identity on every actual-client lease boundary', async () => {
  const f = fixture();
  const login = FrozenHostCodexLogin.capture(f.profile, { privateRoot: f.privateRoot });
  const lease = await login.connect(() => f.client);
  f.client.request.mockResolvedValueOnce({
    account: { type: 'chatgpt', email: 'other@example.test', planType: 'plus' },
  });
  await expect(lease.assertCurrent()).rejects.toThrow('Host Codex login unavailable');
  await expect(lease.assertCurrent()).rejects.toThrow('Host Codex login unavailable');
  expect(f.client.close).toHaveBeenCalledTimes(1);
});

it.each([
  'symlink-root',
  'symlink-auth',
  'wide-auth',
  'api-key',
  'missing-tokens',
  'oversized',
  'native',
  'api-plan',
] as const)('rejects unsafe %s without leaking credentials or paths', (kind) => {
  const f = fixture();
  if (kind === 'symlink-root') {
    const link = join(f.root, 'alias');
    symlinkSync(f.source, link);
    f.profile.credentialRef = link;
  }
  if (kind === 'symlink-auth') {
    renameSync(join(f.source, 'auth.json'), join(f.source, 'original'));
    symlinkSync('original', join(f.source, 'auth.json'));
  }
  if (kind === 'wide-auth') chmodSync(join(f.source, 'auth.json'), 0o644);
  if (kind === 'api-key')
    writeFileSync(
      join(f.source, 'auth.json'),
      JSON.stringify({ OPENAI_API_KEY: 'fixture-secret-api-key' }),
    );
  if (kind === 'missing-tokens') writeFileSync(join(f.source, 'auth.json'), '{}');
  if (kind === 'oversized')
    writeFileSync(join(f.source, 'auth.json'), 'fixture-secret'.repeat(100_000));
  if (kind === 'native') Object.assign(f.profile, { nativeAuth: 'sandbox-chatgpt' });
  if (kind === 'api-plan') f.profile.planType = ' API ';
  expect(() => FrozenHostCodexLogin.capture(f.profile, { privateRoot: f.privateRoot })).toThrow(
    'Host Codex login unavailable',
  );
  try {
    FrozenHostCodexLogin.capture(f.profile, { privateRoot: f.privateRoot });
  } catch (error) {
    expect(String(error)).not.toMatch(/fixture-secret|\/source|\/alias/);
  }
});

it('cancellation closes the same owned client and never deletes the retained home', async () => {
  const f = fixture(),
    controller = new AbortController();
  const login = FrozenHostCodexLogin.capture(f.profile, {
    privateRoot: f.privateRoot,
    signal: controller.signal,
  });
  const lease = await login.connect(() => f.client);
  controller.abort();
  expect(f.client.close).toHaveBeenCalledTimes(1);
  await expect(lease.assertCurrent()).rejects.toThrow('Host Codex login unavailable');
  expect(readFileSync(join(login.privateHome, 'auth.json'), 'utf8')).toBe(auth);
});

it('attributes retained custody to the admitted bootstrap ID and never adopts its prior home', () => {
  const f = fixture(),
    bootstrapId = 'a'.repeat(64);
  const login = FrozenHostCodexLogin.capture(f.profile, {
    privateRoot: f.privateRoot,
    bootstrapId,
  });
  expect(login.privateHome).toBe(join(f.privateRoot, `host-login-${bootstrapId}`));
  expect(() =>
    FrozenHostCodexLogin.capture(f.profile, { privateRoot: f.privateRoot, bootstrapId }),
  ).toThrow('Host Codex login unavailable');
  expect(() =>
    FrozenHostCodexLogin.capture(f.profile, {
      privateRoot: f.privateRoot,
      bootstrapId: '../escape',
    }),
  ).toThrow('Host Codex login unavailable');
});
