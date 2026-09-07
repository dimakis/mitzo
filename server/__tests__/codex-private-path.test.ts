import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
