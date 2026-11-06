import { generateKeyPairSync } from 'node:crypto';
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
import { refreshedAuth, signingKey } from './fixtures/codex-refresh-auth.js';
import { privateCodexPathSnapshot } from '../codex-private-path.js';

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

it('reopens the original retained home from custody evidence and rejects substituted files', async () => {
  const f = fixture();
  const login = FrozenHostCodexLogin.capture(f.profile, { privateRoot: f.privateRoot });
  const snapshot = login.custodySnapshot();
  const lease = await login.connect(() => f.client);
  writeFileSync(join(login.privateHome, 'retained-history'), 'original thread');
  lease.close();
  const reopened = FrozenHostCodexLogin.reopen(f.profile, snapshot);
  expect(reopened.privateHome).toBe(login.privateHome);
  expect(readFileSync(join(reopened.privateHome, 'retained-history'), 'utf8')).toBe(
    'original thread',
  );
  await reopened.connect(() => ({ ...f.client, close: vi.fn() }));
  renameSync(join(login.privateHome, 'auth.json'), join(login.privateHome, 'old-auth'));
  writeFileSync(join(login.privateHome, 'auth.json'), auth, { mode: 0o600 });
  expect(() => FrozenHostCodexLogin.reopen(f.profile, snapshot)).toThrow(
    'Host Codex login unavailable',
  );
});

it('reopens one retained chat without changing another chat’s private-root snapshot', () => {
  const f = fixture();
  const login = FrozenHostCodexLogin.capture(f.profile, { privateRoot: f.privateRoot });
  const before = privateCodexPathSnapshot();
  const reopened = FrozenHostCodexLogin.reopen(f.profile, login.custodySnapshot());
  const after = privateCodexPathSnapshot();
  expect(after.roots).toEqual(before.roots);
  expect(after.isPrivate(join(reopened.privateHome, 'auth.json'))).toBe(true);
});

function refreshFixture() {
  const f = fixture();
  const epoch = Math.floor(Date.now() / 1000) - 60;
  writeFileSync(join(f.source, 'auth.json'), refreshedAuth(epoch));
  const fetch = vi.fn(
    async (url: string | URL, _options?: RequestInit) =>
      new Response(
        JSON.stringify(
          String(url).endsWith('openid-configuration')
            ? {
                issuer: 'https://auth.openai.com',
                jwks_uri: 'https://auth.openai.com/fixture-jwks',
              }
            : {
                keys: [
                  {
                    ...signingKey.publicKey.export({ format: 'jwk' }),
                    kid: 'fixture-key',
                    alg: 'RS256',
                    use: 'sig',
                  },
                ],
              },
        ),
      ),
  );
  vi.stubGlobal('fetch', fetch);
  return { ...f, epoch, fetch };
}
afterEach(() => vi.unstubAllGlobals());

it('keeps a new chat usable when its owned native client refreshes during initialization', async () => {
  const f = refreshFixture();
  const login = FrozenHostCodexLogin.capture(f.profile, { privateRoot: f.privateRoot });
  const original = login.custodySnapshot();
  f.client.initialize.mockImplementationOnce(async () => {
    writeFileSync(join(login.privateHome, 'auth.json'), refreshedAuth(f.epoch + 30));
  });
  const lease = await login.connect(() => f.client);
  expect(() => lease.assertCurrentSync()).not.toThrow();
  await lease.assertCurrent();
  expect(login.custodySnapshot()).toEqual(original);
  expect(f.client.close).not.toHaveBeenCalled();
});

it('retains the same signed login across source/private refresh and a cold reopen', async () => {
  const f = refreshFixture();
  const login = FrozenHostCodexLogin.capture(f.profile, { privateRoot: f.privateRoot });
  const custody = login.custodySnapshot();
  const lease = await login.connect(() => f.client);
  writeFileSync(join(login.privateHome, 'auth.json'), refreshedAuth(f.epoch + 30));
  writeFileSync(join(f.source, 'auth.json'), refreshedAuth(f.epoch + 40));
  expect(() => lease.assertCurrentSync()).not.toThrow();
  await lease.assertCurrent();
  lease.close();
  const reopened = FrozenHostCodexLogin.reopen(f.profile, custody);
  expect(reopened.custodySnapshot()).toEqual(custody);
  const next = await reopened.connect(() => ({ ...f.client, close: vi.fn() }));
  await next.assertCurrent();
  expect(reopened.privateHome).toBe(login.privateHome);
});

it.each([
  'session',
  'principal',
  'account',
  'plan',
  'signature',
  'access',
  'expired',
  'refresh-only',
  'not-before',
  'replacement',
  'cancelled',
])(
  'rejects %s drift at the real login boundary after accepting one signed refresh',
  async (kind) => {
    const f = refreshFixture();
    const controller = new AbortController();
    const login = FrozenHostCodexLogin.capture(f.profile, {
      privateRoot: f.privateRoot,
      signal: controller.signal,
    });
    const lease = await login.connect(() => f.client);
    const path = join(login.privateHome, 'auth.json');
    writeFileSync(path, refreshedAuth(f.epoch + 20));
    await lease.assertCurrent();
    let changed = refreshedAuth(f.epoch + 30, {
      ...(kind === 'session' ? { sid: 'another-login' } : {}),
      ...(kind === 'principal' ? { sub: 'another-user' } : {}),
      ...(kind === 'account'
        ? {
            'https://api.openai.com/auth': {
              chatgpt_account_id: 'other',
              chatgpt_plan_type: 'plus',
            },
          }
        : {}),
      ...(kind === 'plan'
        ? {
            'https://api.openai.com/auth': {
              chatgpt_account_id: 'fixture-account',
              chatgpt_plan_type: 'pro',
            },
          }
        : {}),
      ...(kind === 'expired' ? { exp: f.epoch - 100 } : {}),
      ...(kind === 'not-before' ? { nbf: f.epoch + 10000 } : {}),
    });
    if (kind === 'signature') {
      const doc = JSON.parse(changed);
      const bits = doc.tokens.id_token.split('.');
      const bytes = Buffer.from(bits[2], 'base64url');
      bytes[0] ^= 1;
      bits[2] = bytes.toString('base64url');
      doc.tokens.id_token = bits.join('.');
      changed = JSON.stringify(doc);
    }
    if (kind === 'access' || kind === 'refresh-only') {
      const doc = JSON.parse(kind === 'refresh-only' ? refreshedAuth(f.epoch + 20) : changed);
      doc.tokens[kind === 'access' ? 'access_token' : 'refresh_token'] = 'substituted';
      changed = JSON.stringify(doc);
    }
    if (kind === 'replacement') renameSync(path, `${path}.retained`);
    writeFileSync(path, changed, { mode: 0o600 });
    if (kind === 'cancelled') controller.abort();
    if (kind === 'replacement' || kind === 'cancelled')
      await expect(lease.assertCurrent()).rejects.toThrow('Host Codex login unavailable');
    else
      await expect(lease.assertCurrent()).rejects.toMatchObject({ code: 'login_refresh_invalid' });
    expect(f.client.close).toHaveBeenCalledTimes(1);
  },
);

it.each(['source-session', 'source-routing', 'source-replacement', 'rollback', 'unknown-key'])(
  'preserves the refresh fence for %s',
  async (kind) => {
    const f = refreshFixture();
    const login = FrozenHostCodexLogin.capture(f.profile, { privateRoot: f.privateRoot });
    const custody = login.custodySnapshot();
    const lease = await login.connect(() => f.client);
    const path = join(kind.startsWith('source-') ? f.source : login.privateHome, 'auth.json');
    writeFileSync(path, refreshedAuth(f.epoch + 20));
    await lease.assertCurrent();
    let replacement = refreshedAuth(f.epoch + 30, {
      ...(kind === 'source-session' ? { sid: 'different-login' } : {}),
    });
    if (kind === 'source-routing' || kind === 'unknown-key') {
      const doc = JSON.parse(replacement);
      if (kind === 'source-routing') doc.tokens.account_id = 'different-routing-id';
      else {
        const parts = doc.tokens.id_token.split('.');
        parts[0] = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'unknown' })).toString(
          'base64url',
        );
        doc.tokens.id_token = parts.join('.');
      }
      replacement = JSON.stringify(doc);
    }
    if (kind === 'rollback') replacement = refreshedAuth(f.epoch);
    if (kind === 'same-second') replacement = refreshedAuth(f.epoch + 20, { jti: 'another-token' });
    if (kind === 'source-replacement') renameSync(path, `${path}.old`);
    writeFileSync(path, replacement, { mode: 0o600 });
    lease.close();
    if (kind === 'unknown-key') {
      const reopened = FrozenHostCodexLogin.reopen(f.profile, custody);
      await expect(reopened.connect(() => f.client)).rejects.toMatchObject({
        code: 'login_verification_unavailable',
      });
    } else expect(() => FrozenHostCodexLogin.reopen(f.profile, custody)).toThrow();
  },
);

it.each(['foreign-issuer', 'foreign-keys', 'oversized', 'http-failure'])(
  'refuses %s signing-key discovery before native launch',
  async (kind) => {
    const f = refreshFixture();
    f.fetch.mockImplementation(
      async () =>
        new Response(
          kind === 'oversized'
            ? 'x'.repeat(128 * 1024 + 1)
            : JSON.stringify({
                issuer:
                  kind === 'foreign-issuer' ? 'https://other.invalid' : 'https://auth.openai.com',
                jwks_uri:
                  kind === 'foreign-keys'
                    ? 'https://other.invalid/keys'
                    : 'https://auth.openai.com/fixture-jwks',
              }),
          { status: kind === 'http-failure' ? 503 : 200 },
        ),
    );
    const login = FrozenHostCodexLogin.capture(f.profile, { privateRoot: f.privateRoot });
    const launch = vi.fn(() => f.client);
    await expect(login.connect(launch)).rejects.toMatchObject({
      code: 'login_verification_unavailable',
    });
    expect(launch).not.toHaveBeenCalled();
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.fetch.mock.calls[0][1]).toMatchObject({ redirect: 'error', credentials: 'omit' });
  },
);

it('cancels a key-discovery waiter without cancelling another login or launching the cancelled owner', async () => {
  const f = refreshFixture();
  const response = f.fetch.getMockImplementation()!;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.fetch.mockImplementation(async (url) => {
    await ready;
    return response(url);
  });
  const cancelled = new AbortController();
  const first = FrozenHostCodexLogin.capture(f.profile, {
    privateRoot: f.privateRoot,
    signal: cancelled.signal,
  });
  const second = FrozenHostCodexLogin.capture(f.profile, { privateRoot: f.privateRoot });
  const firstLaunch = vi.fn(() => f.client);
  const blocked = expect(first.connect(firstLaunch)).rejects.toThrow(
    'Host Codex login unavailable',
  );
  const usable = second.connect(() => f.client);
  cancelled.abort();
  await blocked;
  expect(firstLaunch).not.toHaveBeenCalled();
  const escaped = vi.fn(async () => {
    throw Error('discovery escaped its original transport');
  });
  vi.stubGlobal('fetch', escaped);
  release();
  const lease = await usable;
  expect(escaped).not.toHaveBeenCalled();
  expect(() => lease.assertCurrentSync()).not.toThrow();
  expect(f.fetch).toHaveBeenCalledTimes(2);
  lease.close();
});

it('reports a legacy rotated login before physical close and preserves its original files', async () => {
  const f = fixture();
  const login = FrozenHostCodexLogin.capture(f.profile, { privateRoot: f.privateRoot });
  const beforeClose = vi.fn(() => expect(f.client.close).not.toHaveBeenCalled());
  const lease = await login.connect(() => f.client, beforeClose);
  const changed = refreshedAuth(Math.floor(Date.now() / 1000));
  writeFileSync(join(login.privateHome, 'auth.json'), changed);
  await expect(lease.assertCurrent()).rejects.toMatchObject({
    code: 'login_refresh_reauthorization',
  });
  expect(beforeClose).toHaveBeenCalledOnce();
  expect(f.client.close).toHaveBeenCalledOnce();
  expect(readFileSync(join(login.privateHome, 'auth.json'), 'utf8')).toBe(changed);
});

it('accepts a distinct signed same-second refresh and rejects replay of its earlier token pair', async () => {
  const f = refreshFixture();
  const login = FrozenHostCodexLogin.capture(f.profile, { privateRoot: f.privateRoot });
  const custody = login.custodySnapshot();
  const lease = await login.connect(() => f.client);
  const path = join(login.privateHome, 'auth.json');
  const first = refreshedAuth(f.epoch + 20);
  writeFileSync(path, first);
  await lease.assertCurrent();
  for (let index = 1; index < 32; index++) {
    // Both role histories exercise the complete supported ledger bound, not a
    // load sample: the prior 4KiB reader failed below this valid schema limit.
    const rotated = refreshedAuth(f.epoch + 20, { jti: `signed-pair-${index}` });
    writeFileSync(path, rotated);
    writeFileSync(join(f.source, 'auth.json'), rotated);
    await lease.assertCurrent();
  }
  expect(f.fetch).toHaveBeenCalledTimes(2);
  lease.close();
  writeFileSync(path, first);
  expect(() => FrozenHostCodexLogin.reopen(f.profile, custody)).toThrow();
});

it('reloads trusted issuer keys for a valid later rotation and can cold-reopen the same custody', async () => {
  const f = refreshFixture();
  const rotatedKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const login = FrozenHostCodexLogin.capture(f.profile, { privateRoot: f.privateRoot });
  const custody = login.custodySnapshot();
  const lease = await login.connect(() => f.client);
  f.fetch.mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify(
          String(url).endsWith('openid-configuration')
            ? {
                issuer: 'https://auth.openai.com',
                jwks_uri: 'https://auth.openai.com/fixture-jwks',
              }
            : {
                keys: [
                  {
                    ...signingKey.publicKey.export({ format: 'jwk' }),
                    kid: 'fixture-key',
                    alg: 'RS256',
                    use: 'sig',
                  },
                  {
                    ...rotatedKey.publicKey.export({ format: 'jwk' }),
                    kid: 'rotated-key',
                    alg: 'RS256',
                    use: 'sig',
                  },
                ],
              },
        ),
      ),
  );
  writeFileSync(
    join(login.privateHome, 'auth.json'),
    refreshedAuth(f.epoch + 20, {}, rotatedKey, 'rotated-key'),
  );
  await lease.qualifyCredentialRefresh!(new AbortController().signal);
  expect(() => lease.assertCurrentSync()).not.toThrow();
  await lease.assertCurrent();
  expect(f.fetch).toHaveBeenCalledTimes(4);
  lease.close();
  const reopened = FrozenHostCodexLogin.reopen(f.profile, custody);
  const next = await reopened.connect(() => ({ ...f.client, close: vi.fn() }));
  await next.assertCurrent();
  expect(reopened.custodySnapshot()).toEqual(custody);
  next.close();
});

it('qualifies issuer rotation during the initial account response before admitting the chat', async () => {
  const f = refreshFixture();
  const login = FrozenHostCodexLogin.capture(f.profile, { privateRoot: f.privateRoot });
  const custody = login.custodySnapshot();
  const originalRequest = f.client.request.getMockImplementation()!;
  f.client.request.mockImplementationOnce(async () => {
    f.fetch.mockImplementation(
      async (url) =>
        new Response(
          JSON.stringify(
            String(url).endsWith('openid-configuration')
              ? {
                  issuer: 'https://auth.openai.com',
                  jwks_uri: 'https://auth.openai.com/fixture-jwks',
                }
              : {
                  keys: ['fixture-key', 'account-response-key'].map((kid) => ({
                    ...signingKey.publicKey.export({ format: 'jwk' }),
                    kid,
                    alg: 'RS256',
                    use: 'sig',
                  })),
                },
          ),
        ),
    );
    writeFileSync(
      join(login.privateHome, 'auth.json'),
      refreshedAuth(f.epoch + 30, {}, signingKey, 'account-response-key'),
    );
    return originalRequest();
  });
  const lease = await login.connect(() => f.client);
  expect(f.client.close).not.toHaveBeenCalled();
  expect(f.fetch).toHaveBeenCalledTimes(4);
  expect(login.custodySnapshot()).toEqual(custody);
  lease.close();
});

it('cold-reopens after an interrupted inactive ledger write without losing the last accepted version', async () => {
  const { openSync, closeSync, writeSync } = await import('node:fs');
  const { readLoginRefreshLedger, LOGIN_REFRESH_SLOT_BYTES } =
    await import('../host-codex-login-refresh-ledger.js');
  const f = refreshFixture();
  const login = FrozenHostCodexLogin.capture(f.profile, { privateRoot: f.privateRoot });
  const custody = login.custodySnapshot();
  const lease = await login.connect(() => f.client);
  const home = join(login.privateHome, 'auth.json');
  for (let index = 0; index < 4; index++) {
    writeFileSync(home, refreshedAuth(f.epoch + 20, { jti: `accepted-${index}` }));
    await lease.assertCurrent();
  }
  lease.close();
  const ledger = join(login.privateHome, 'login-refresh.json');
  const previous = readLoginRefreshLedger(readFileSync(ledger));
  writeFileSync(home, refreshedAuth(f.epoch + 30));
  const fd = openSync(ledger, 'r+');
  try {
    const prefix = Buffer.from(
      JSON.stringify({ sequence: previous.sequence + 1, state: previous.state }).slice(0, 64),
    );
    writeSync(fd, prefix, 0, prefix.length, (1 - previous.slot) * LOGIN_REFRESH_SLOT_BYTES);
  } finally {
    closeSync(fd);
  }
  expect(readLoginRefreshLedger(readFileSync(ledger))).toEqual(previous);
  const reopened = FrozenHostCodexLogin.reopen(f.profile, custody);
  const next = await reopened.connect(() => ({ ...f.client, close: vi.fn() }));
  expect(() => next.assertCurrentSync()).not.toThrow();
  expect(statSync(ledger).ino).toBe(custody.refreshProof!.ledger.ino);
  next.close();
  writeFileSync(home, refreshedAuth(f.epoch + 20, { jti: 'accepted-3' }));
  expect(() => FrozenHostCodexLogin.reopen(f.profile, custody)).toThrow();
});
