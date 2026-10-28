import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { isPrivateCodexPath, createCodexPathProtection } from '../codex-private-path.js';
it('protects continuation directories, descendants, nonexistent writes and symlink aliases without blocking sibling names', () => {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-private-'));
  const secret = join(root, 'private');
  mkdirSync(secret);
  writeFileSync(join(secret, 'db'), 'private');
  symlinkSync(secret, join(root, 'alias'));
  try {
    for (const p of [
      secret,
      join(secret, 'db'),
      join(secret, 'new'),
      join(root, 'alias', 'db'),
      join(root, 'alias', 'new'),
    ])
      expect(isPrivateCodexPath(p, [secret])).toBe(true);
    expect(isPrivateCodexPath(join(root, 'private-copy'), [secret])).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('keeps known private roots across broken configuration updates and loads once per snapshot', () => {
  const load = vi.fn(() => ['/private-codex-test']);
  const snapshot = createCodexPathProtection(load);
  let check = snapshot();
  for (let i = 0; i < 10; i++) expect(check('/ordinary-test/file')).toBe(false);
  expect(load).toHaveBeenCalledTimes(1);
  load.mockImplementation(() => {
    throw new Error('malformed profile');
  });
  check = snapshot();
  expect(check('/ordinary-test/file')).toBe(false);
  expect(check('/private-codex-test/login')).toBe(true);
});
it('fails closed without a known configuration and recovers after it is repaired', () => {
  const load = vi.fn<() => string[]>(() => {
    throw new Error('unreadable');
  });
  const snapshot = createCodexPathProtection(load);
  expect(snapshot()('/ordinary-test/file')).toBe(true);
  load.mockReturnValue(['/private-codex-test']);
  expect(snapshot()('/ordinary-test/file')).toBe(false);
});
it('does not treat a symlink resolution failure as an ordinary missing path', () => {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-loop-'));
  symlinkSync(join(root, 'loop'), join(root, 'loop'));
  try {
    expect(() => isPrivateCodexPath(join(root, 'loop', 'file'))).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('protects Mitzo auth and other local credential stores for every native tool', () => {
  const check = createCodexPathProtection(() => [])();
  for (const file of [
    '.mitzo/internal-token',
    '.claude.json',
    '.ssh/id_ed25519',
    '.config/gcloud/application_default_credentials.json',
    'Library/Keychains/login.keychain-db',
  ])
    expect(check(join(homedir(), file))).toBe(true);
  expect(check(join(homedir(), 'ordinary-project', 'README.md'))).toBe(false);
});

it('protects host OpenShell operator credentials from native agent reads', () => {
  expect(
    isPrivateCodexPath(
      join(homedir(), '.config', 'openshell', 'gateways', 'relay', 'mtls', 'tls.key'),
    ),
  ).toBe(true);
});

it('keeps a fresh-process policy stable when a retained login reopens before any capture', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-cold-private-'));
  const privateRoot = join(root, 'private');
  mkdirSync(privateRoot);
  mkdirSync(join(privateRoot, 'host-login-retained'));
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', privateRoot);
  vi.resetModules();
  try {
    const fresh = await import('../codex-private-path.js');
    // A new process has no observed parent registration from capture(). Its
    // configured private directory already protects every retained login.
    const before = fresh.privateCodexPathSnapshot();
    fresh.protectCodexProfileRoots([join(privateRoot, 'host-login-retained')]);
    const after = fresh.privateCodexPathSnapshot();
    expect(after.roots).toEqual(before.roots);
    expect(after.isPrivate(join(privateRoot, 'host-login-retained', 'auth.json'))).toBe(true);
    vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', join(root, 'replacement'));
    expect(
      fresh
        .privateCodexPathSnapshot()
        .isPrivate(join(privateRoot, 'host-login-retained', 'auth.json')),
    ).toBe(true);
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
