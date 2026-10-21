import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountBinding } from '@mitzo/protocol';
import { FrozenHostCodexApiLogin } from '../frozen-host-codex-api-login.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
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
  f.authority.assertReady.mockRejectedValue(Error('Private controller error'));
  await expect(
    FrozenHostCodexApiLogin.capture(binding, {
      privateRoot: f.root,
      bootstrapId: 'c'.repeat(64),
      authority: f.authority,
      signal: controller.signal,
    }),
  ).rejects.toThrow('API Codex login unavailable');
});
