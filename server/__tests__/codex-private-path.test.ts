import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { isPrivateCodexPath } from '../codex-private-path.js';
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
