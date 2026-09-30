import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stableSymposiumArtifactLeasePath } from '../symposium-artifact-state.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root() {
  const path = mkdtempSync(join(tmpdir(), 'artifact-state-'));
  roots.push(path);
  return path;
}
it('returns the same stable ledger across independent gateway launch directories', () => {
  const parent = root();
  const first = stableSymposiumArtifactLeasePath(parent);
  writeFileSync(first, '', { mode: 0o600 });
  mkdirSync(join(parent, 'gateway-first'), { mode: 0o700 });
  mkdirSync(join(parent, 'gateway-second'), { mode: 0o700 });
  expect(stableSymposiumArtifactLeasePath(parent)).toBe(first);
});
it.each(['', '-wal', '-shm'])(
  'refuses legacy per-launch state including orphan %s without adopting it',
  (suffix) => {
    const parent = root();
    const legacy = join(parent, 'gateway-old');
    mkdirSync(legacy, { mode: 0o700 });
    writeFileSync(join(legacy, `artifact-leases.db${suffix}`), 'unresolved', { mode: 0o600 });
    writeFileSync(join(parent, 'artifact-leases.db'), 'new', { mode: 0o600 });
    expect(() => stableSymposiumArtifactLeasePath(parent)).toThrow(/requires reconciliation/);
  },
);
it('rejects a symlinked ledger and legacy directory instead of following custody', () => {
  const parent = root();
  const other = root();
  symlinkSync(other, join(parent, 'gateway-old'));
  expect(() => stableSymposiumArtifactLeasePath(parent)).toThrow(/reconciliation/);
  unlinkSync(join(parent, 'gateway-old'));
  writeFileSync(join(other, 'db'), '', { mode: 0o600 });
  symlinkSync(join(other, 'db'), join(parent, 'artifact-leases.db'));
  expect(() => stableSymposiumArtifactLeasePath(parent)).toThrow(/private regular/);
});
