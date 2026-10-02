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
    (markDispatched) => {
      markDispatched();
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
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
    (markDispatched) => {
      markDispatched();
      return new Promise<void>((_, reject) => {
        fail = reject;
      });
    },
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
it('does not quarantine preflight failures before explicit external dispatch', async () => {
  const { fence, path } = fixture();
  await expect(
    fence.create(
      () => {},
      async () => {
        throw new Error('provider read unavailable');
      },
    ),
  ).rejects.toThrow('provider read');
  await expect(fence.cleanup(async () => {})).resolves.toBeUndefined();
  await expect(
    new SymposiumWorkspaceLifecycle(path, () => {}).cleanup(async () => {}),
  ).resolves.toBeUndefined();
});
it('refuses a successful create result without its trusted dispatch marker', async () => {
  const { fence } = fixture();
  await expect(
    fence.create(
      () => {},
      async () => 'unproven',
    ),
  ).rejects.toThrow('dispatch was not recorded');
  await expect(fence.cleanup(async () => {})).resolves.toBeUndefined();
});

it('fences queued creates and waits for an already dispatched create before draining', async () => {
  const { fence } = fixture();
  let release!: () => void;
  const first = fence.create(
    () => {},
    async (mark) => {
      mark();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  );
  await Promise.resolve();
  const queuedOperation = vi.fn(async () => {});
  const queued = expect(fence.create(() => {}, queuedOperation)).rejects.toThrow('shutting down');
  let drained = false;
  fence.beginDrain();
  const drain = fence.drain(new AbortController().signal).then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  release();
  await first;
  await queued;
  await drain;
  expect(queuedOperation).not.toHaveBeenCalled();
  await expect(fence.create(() => {}, queuedOperation)).rejects.toThrow('shutting down');
  await expect(fence.cleanup(async () => {})).resolves.toBeUndefined();
});
it('allows cleanup after a persisted terminal receipt even when later configuration fails', async () => {
  const { fence } = fixture();
  await expect(
    fence.create(
      () => {},
      async (dispatched, settled) => {
        dispatched();
        settled!();
        throw new Error('upload failed');
      },
    ),
  ).rejects.toThrow('upload failed');
  await expect(fence.cleanup(async () => 'cleanup permitted')).resolves.toBe('cleanup permitted');
});
it('retains uncertainty if custody changes before terminal receipt settlement', async () => {
  const { path } = fixture();
  let current = true;
  const fence = new SymposiumWorkspaceLifecycle(path, () => {
    if (!current) throw new Error('custody lost');
  });
  await expect(
    fence.create(
      () => {},
      async (dispatched, settled) => {
        dispatched();
        current = false;
        settled!();
      },
    ),
  ).rejects.toThrow('custody lost');
  current = true;
  await expect(fence.cleanup(async () => {})).rejects.toThrow('recovery');
});
it('quiesces controller work without permanently shutting down retained creation custody', async () => {
  const { fence } = fixture();
  fence.pauseController();
  const physical = vi.fn(async (dispatch: () => void) => {
    dispatch();
  });
  await expect(fence.create(() => {}, physical)).rejects.toThrow('controller');
  expect(physical).not.toHaveBeenCalled();
  await fence.quiesceController(new AbortController().signal);
  await fence.cleanup(async () => {});
  fence.resumeController();
  await expect(fence.create(() => {}, physical)).resolves.toBeUndefined();
  expect(physical).toHaveBeenCalledOnce();
  fence.beginDrain();
  expect(() => fence.resumeController()).toThrow('shutting down');
});
it('does not let a replacement controller clear an uncertain dispatched creation', async () => {
  const { fence } = fixture();
  await expect(
    fence.create(
      () => {},
      async (dispatch) => {
        dispatch();
        throw Error('lost receipt');
      },
    ),
  ).rejects.toThrow('lost receipt');
  fence.pauseController();
  await expect(fence.quiesceController(new AbortController().signal)).rejects.toThrow('recovery');
  expect(() => fence.resumeController()).toThrow('recovery');
});
