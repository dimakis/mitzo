import { resetOfflineUserEnvironment } from './fixtures/offline-user-home.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeFailureSchema, runtimeFailureMessage, type AccountBinding } from '@mitzo/protocol';
import { FrozenHostCodexApiLogin } from '../frozen-host-codex-api-login.js';
import { OwnedCodexLifecycleBridge } from '../owned-codex-lifecycle-bridge.js';
import type { FrozenHostCodexBootstrapLease } from '../frozen-host-codex-bootstrap.js';
import { CodexTransportError } from '../codex-app-server-client.js';
import { findSessionRuntimeError } from '../session-runtime-error.js';
import * as boundedRead from '../bounded-file-read.js';
const schemas = vi.hoisted(() => ({ objects: 0 }));
vi.mock('zod', async (importOriginal) => {
  const actual = await importOriginal<typeof import('zod')>();
  return {
    ...actual,
    z: {
      ...actual.z,
      object: (...args: Parameters<typeof actual.z.object>) => {
        schemas.objects++;
        return actual.z.object(...args);
      },
    },
  };
});
const roots: string[] = [];
beforeEach(resetOfflineUserEnvironment);
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
afterEach(() => vi.restoreAllMocks());
const binding: AccountBinding = {
  accountId: 'work',
  accountLabel: 'Work API',
  provider: 'openai',
  model: 'offline-model',
  profileRevision: 'revision',
};
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-api-login-')));
  roots.push(root);
  let key = 'synthetic-api-key';
  const authority = { assertReady: vi.fn(async () => {}), resolveKey: vi.fn(async () => key) };
  const rpc = {
    initialize: vi.fn(async () => {}),
    close: vi.fn(),
    request: vi.fn(async () => ({ account: { type: 'apiKey' }, requiresOpenaiAuth: true })),
  };
  const launch = vi.fn(async (home: string) => {
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: key }), {
      mode: 0o600,
      flag: 'wx',
    });
    return rpc;
  });
  return {
    root,
    authority,
    rpc,
    launch,
    rotate: () => {
      key = 'different-synthetic-key';
    },
  };
}
it('publishes a raw API credential failure before physical close reenters the actual lifecycle owner', async () => {
  const f = fixture();
  const login = await FrozenHostCodexApiLogin.capture(binding, {
    privateRoot: f.root,
    bootstrapId: '1'.repeat(64),
    authority: f.authority,
    signal: new AbortController().signal,
  });
  const state: { lease?: FrozenHostCodexBootstrapLease } = {};
  const bridge = new OwnedCodexLifecycleBridge(() => state.lease);
  const onClose = vi.fn();
  const connected = await login.connect(f.launch, (failure) => bridge.lifecycle.onClose(failure));
  state.lease = {
    ...connected,
    profile: {
      accountId: binding.accountId,
      accountLabel: binding.accountLabel,
      model: binding.model,
      email: 'api',
      planType: 'api',
    },
    privateHome: login.privateHome,
    executableSha256: 'a'.repeat(64),
  };
  bridge.attach({ onNotification: vi.fn(), onRequest: vi.fn(async () => ({})), onClose });
  f.rpc.close.mockImplementation(() =>
    bridge.lifecycle.onClose(new CodexTransportError('connection')),
  );
  const original = Object.assign(Error('private/path secret-token'), { code: 'EPERM' });
  f.authority.resolveKey.mockRejectedValue(original);
  const error = await connected.assertCredentialCurrent!(new AbortController().signal).catch(
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe('API Codex login unavailable');
  const failure = findSessionRuntimeError(error)!;
  expect(failure).toMatchObject({ code: 'tool_validation_failed', cause: original });
  expect(onClose).toHaveBeenCalledExactlyOnceWith(failure);
  expect(f.rpc.close).toHaveBeenCalledOnce();
  expect(runtimeFailureMessage(RuntimeFailureSchema.parse(failure.telemetry()))).toBe(
    failure.publicMessage(),
  );
  expect(JSON.stringify(failure.telemetry())).not.toMatch(/private\/path|secret-token/);
  expect(failure.publicMessage()).not.toMatch(/private\/path|secret-token/);
});
it('captures the key once and checks it afresh before any later launch', async () => {
  const f = fixture();
  const login = await FrozenHostCodexApiLogin.capture(binding, {
    privateRoot: f.root,
    bootstrapId: 'e'.repeat(64),
    authority: f.authority,
    signal: new AbortController().signal,
  });
  expect(f.authority.resolveKey).toHaveBeenCalledOnce();
  f.rotate();
  await expect(login.connect(f.launch)).rejects.toThrow('API Codex login unavailable');
  expect(f.launch).not.toHaveBeenCalled();
  expect(f.authority.resolveKey).toHaveBeenCalledTimes(2);
});
it('uses one controller-qualified key read for a host-tool fence without account/model discovery', async () => {
  const f = fixture();
  const login = await FrozenHostCodexApiLogin.capture(binding, {
    privateRoot: f.root,
    bootstrapId: 'd'.repeat(64),
    authority: f.authority,
    signal: new AbortController().signal,
  });
  const lease = await login.connect(f.launch);
  f.authority.resolveKey.mockClear();
  f.authority.assertReady.mockClear();
  f.rpc.request.mockClear();
  await lease.assertCredentialCurrent!(new AbortController().signal);
  expect(f.authority.resolveKey).toHaveBeenCalledOnce();
  expect(f.authority.assertReady).not.toHaveBeenCalled();
  expect(f.rpc.request).not.toHaveBeenCalled();
  f.rotate();
  await expect(lease.assertCredentialCurrent!(new AbortController().signal)).rejects.toThrow();
  expect(f.rpc.close).toHaveBeenCalledOnce();
});
it('reuses auth validation without rebuilding schemas or caching fresh credential reads', async () => {
  const f = fixture();
  const login = await FrozenHostCodexApiLogin.capture(binding, {
    privateRoot: f.root,
    bootstrapId: 'f'.repeat(64),
    authority: f.authority,
    signal: new AbortController().signal,
  });
  const lease = await login.connect(f.launch);
  const reads = vi.spyOn(boundedRead, 'readBoundedFile');
  schemas.objects = 0;
  for (let index = 0; index < 3; index++) lease.assertCurrentSync();
  expect(reads).toHaveBeenCalledTimes(3);
  expect(schemas.objects).toBe(0);
  writeFileSync(join(login.privateHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 123 }), {
    mode: 0o600,
  });
  expect(() => lease.assertCurrentSync()).toThrow('API Codex login unavailable');
  expect(reads).toHaveBeenCalledTimes(4);
  expect(schemas.objects).toBe(0);
  expect(f.rpc.close).toHaveBeenCalledOnce();
});
it('retains a private API login and resumes its exact billing account and physical home', async () => {
  const f = fixture(),
    signal = new AbortController().signal;
  const login = await FrozenHostCodexApiLogin.capture(binding, {
    privateRoot: f.root,
    bootstrapId: 'a'.repeat(64),
    authority: f.authority,
    signal,
  });
  const lease = await login.connect(f.launch);
  expect(lease.binding).toEqual(binding);
  await lease.assertCurrent();
  lease.assertCurrentSync();
  const saved = login.custodySnapshot();
  expect(JSON.stringify(saved)).not.toContain('synthetic-api-key');
  expect(readFileSync(join(saved.privateHome, 'auth.json'), 'utf8')).toContain('synthetic-api-key');
  lease.close();
  const retained = await FrozenHostCodexApiLogin.reopen(binding, saved, f.authority, signal);
  const launchRetained = vi.fn(async () => f.rpc);
  const resumed = await retained.connect(launchRetained);
  expect(launchRetained).toHaveBeenCalledWith(saved.privateHome);
  expect(resumed.binding).toEqual(binding);
  await resumed.assertCurrent();
  f.rotate();
  await expect(resumed.assertCurrent()).rejects.toThrow('API Codex login unavailable');
  expect(f.rpc.close).toHaveBeenCalled();
});
it('refuses account substitution, replaced private auth and loss of the original key authority', async () => {
  const f = fixture(),
    controller = new AbortController();
  const login = await FrozenHostCodexApiLogin.capture(binding, {
    privateRoot: f.root,
    bootstrapId: 'b'.repeat(64),
    authority: f.authority,
    signal: controller.signal,
  });
  const lease = await login.connect(f.launch),
    saved = login.custodySnapshot();
  await expect(
    FrozenHostCodexApiLogin.reopen(
      { ...binding, accountId: 'other' },
      saved,
      f.authority,
      controller.signal,
    ),
  ).rejects.toThrow();
  writeFileSync(
    join(saved.privateHome, 'auth.json'),
    JSON.stringify({ OPENAI_API_KEY: 'replacement' }),
    { mode: 0o600 },
  );
  expect(() => lease.assertCurrentSync()).toThrow();
  await expect(
    FrozenHostCodexApiLogin.reopen(binding, saved, f.authority, controller.signal),
  ).rejects.toThrow();
  f.authority.resolveKey.mockRejectedValue(Error('Private controller error'));
  await expect(
    FrozenHostCodexApiLogin.capture(binding, {
      privateRoot: f.root,
      bootstrapId: 'c'.repeat(64),
      authority: f.authority,
      signal: controller.signal,
    }),
  ).rejects.toThrow('API Codex login unavailable');
});
