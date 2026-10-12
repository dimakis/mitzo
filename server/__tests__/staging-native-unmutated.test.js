import { afterEach, expect, it, vi } from 'vitest';
import process from 'node:process';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const command = vi.hoisted(() =>
  vi.fn(() => ({ status: 113, stderr: 'Could not find service', stdout: '' })),
);
vi.mock('node:child_process', () => ({ spawnSync: command }));
import { createUnmutatedNativeAllocationInspector } from '../../scripts/lib/staging-native-unmutated.mjs';
let temporary;
afterEach(() => {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
  vi.clearAllMocks();
});
function fixture() {
  temporary = realpathSync(mkdtempSync(join(tmpdir(), 'native-unmutated-')));
  const allocation = '22222222-2222-4222-8222-222222222222',
    root = join(temporary, '.local/share/mitzo-staging'),
    nativeRoot = join(root, 'symposium/allocations', allocation);
  for (const name of ['home', 'workspace', 'settings', 'service'])
    mkdirSync(join(nativeRoot, name), { recursive: true, mode: 0o700 });
  writeFileSync(join(nativeRoot, 'settings/config.json'), 'private source config', { mode: 0o600 });
  return { allocation, canonicalRoot: root, nativeRoot };
}
it('rechecks immutable full allocation inputs and actual fresh VM absence without creating a capacity grant', () => {
  const f = fixture(),
    inspector = createUnmutatedNativeAllocationInspector(f);
  const result = inspector.assertUnchanged();
  expect(result.preallocationSnapshotSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(Object.keys(result)).toEqual(['preallocationSnapshotSha256']);
  expect(command).toHaveBeenCalledWith(
    '/bin/launchctl',
    ['print', `gui/${process.getuid()}/com.mitzo.staging.vm`],
    expect.any(Object),
  );
  writeFileSync(join(f.nativeRoot, 'settings/config.json'), 'changed', { mode: 0o600 });
  expect(() => inspector.assertUnchanged()).toThrow('retain');
});
it('refuses preexisting init attempts, nonempty fresh HOME, and unknown VM absence', () => {
  const f = fixture();
  writeFileSync(join(f.nativeRoot, 'service/fresh-vm-init-attempt.json'), '{}', { mode: 0o600 });
  expect(() => createUnmutatedNativeAllocationInspector(f)).toThrow('retain');
  rmSync(join(f.nativeRoot, 'service/fresh-vm-init-attempt.json'));
  writeFileSync(join(f.nativeRoot, 'home/unowned'), '', { mode: 0o600 });
  expect(() => createUnmutatedNativeAllocationInspector(f)).toThrow('retain');
  rmSync(join(f.nativeRoot, 'home/unowned'));
  command.mockReturnValueOnce({ status: 1, stderr: 'permission denied', stdout: '' });
  expect(() => createUnmutatedNativeAllocationInspector(f)).toThrow('retain');
});
