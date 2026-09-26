import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SymposiumWorkspaceLifecycle } from '../symposium-workspace-lifecycle.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'workspace-fence-'));
  roots.push(root);
  const path = join(root, 'fence.json');
  return { path, fence: new SymposiumWorkspaceLifecycle(path, () => {}) };
}
it('holds cleanup until an invisible in-flight sandbox create has completed', async () => {
  const { fence } = fixture();
  let finish!: () => void;
  const deletion = vi.fn(async () => {});
  const create = fence.create(
    () => {},
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await Promise.resolve();
  const cleanup = fence.cleanup(deletion);
  await Promise.resolve();
  expect(deletion).not.toHaveBeenCalled();
  finish();
  await create;
  await cleanup;
  expect(deletion).toHaveBeenCalledOnce();
});
it('retains uncertainty across restart when create rejects or remains in flight', async () => {
  const { fence, path } = fixture();
  let fail!: (error: Error) => void;
  const create = fence.create(
    () => {},
    () =>
      new Promise<void>((_, reject) => {
        fail = reject;
      }),
  );
  await Promise.resolve();
  const restored = new SymposiumWorkspaceLifecycle(path, () => {});
  await expect(restored.cleanup(async () => {})).rejects.toThrow('recovery');
  fail(new Error('unknown create outcome'));
  await expect(create).rejects.toThrow();
  await expect(fence.cleanup(async () => {})).rejects.toThrow('recovery');
});
it('revalidates queued creation after cleanup fences an account, without issuing create', async () => {
  const { fence } = fixture();
  let authorized = true;
  let finish!: () => void;
  const cleanup = fence.cleanup(
    () =>
      new Promise<void>((resolve) => {
        authorized = false;
        finish = resolve;
      }),
  );
  await Promise.resolve();
  const createOperation = vi.fn(async () => {});
  const create = fence.create(() => {
    if (!authorized) throw new Error('revoked');
  }, createOperation);
  finish();
  await cleanup;
  await expect(create).rejects.toThrow('revoked');
  expect(createOperation).not.toHaveBeenCalled();
  await expect(fence.cleanup(async () => {})).resolves.toBeUndefined();
});
