import { afterEach, expect, it, vi } from 'vitest';
import { captureLocalRepositoryPreparationAuthorization } from '../local-repository-preparation-authorization.js';
import { captureLocalRepositoryPreparationObjectData } from '../local-repository-preparation-object-data.js';
import {
  executeLocalRepositoryPreparation,
  withLocalRepositoryPreparationEnvelope,
} from '../local-repository-preparation-operation.js';
import type { LocalRepositoryPreparationOwners } from '../local-repository-preparation-operation.js';

vi.mock('../local-repository-preparation-authorization.js', () => ({
  captureLocalRepositoryPreparationAuthorization: vi.fn(),
}));
vi.mock('../local-repository-preparation-object-data.js', () => ({
  captureLocalRepositoryPreparationObjectData: vi.fn(),
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});
function fixture() {
  const controller = new AbortController();
  const order: string[] = [];
  const context = Object.freeze({
    signal: controller.signal,
    async assertCurrent() {
      controller.signal.throwIfAborted();
    },
    assertCurrentSync() {
      controller.signal.throwIfAborted();
    },
  });
  const objects = Object.freeze({
    dispose: vi.fn(async () => {
      order.push('dispose');
    }),
  });
  const held = {
    request: { id: 'original' },
    scope: {},
    owner: { context, assertCurrentSync: vi.fn(), assertCurrent: vi.fn(async () => {}) },
    allocationFacts: {},
    allocationFactsSha256: 'f'.repeat(64),
    approve: vi.fn(async () => {
      order.push('approve');
    }),
    materialize: vi.fn(async (actual) => {
      expect(actual).toBe(objects);
      order.push('materialize');
      return { state: 'materialized' };
    }),
  };
  vi.mocked(captureLocalRepositoryPreparationAuthorization).mockResolvedValue(held as never);
  vi.mocked(captureLocalRepositoryPreparationObjectData).mockImplementation(async () => {
    order.push('copy-and-close-reader');
    return objects as never;
  });
  return {
    controller,
    context,
    objects,
    held,
    order,
    owners: { context, qualifySource: vi.fn() } as unknown as LocalRepositoryPreparationOwners,
  };
}
it('joins object copy before approval and keeps its cleanup inside the original callback', async () => {
  const f = fixture();
  await withLocalRepositoryPreparationEnvelope(f.controller.signal, async (envelope) => {
    await expect(
      executeLocalRepositoryPreparation(f.owners, { path: '/fixture' }, envelope),
    ).resolves.toMatchObject({ state: 'materialized' });
  });
  expect(f.order).toEqual(['copy-and-close-reader', 'approve', 'materialize', 'dispose']);
  expect(f.held.approve).toHaveBeenCalledOnce();
  expect(f.objects.dispose).toHaveBeenCalledOnce();
});
it('denial disposes copied data without entering consumed materialization', async () => {
  const f = fixture();
  f.held.approve.mockRejectedValue(Error('synthetic denial'));
  await expect(
    withLocalRepositoryPreparationEnvelope(f.controller.signal, (envelope) =>
      executeLocalRepositoryPreparation(f.owners, { path: '/fixture' }, envelope),
    ),
  ).rejects.toThrow('synthetic denial');
  expect(f.held.materialize).not.toHaveBeenCalled();
  expect(f.objects.dispose).toHaveBeenCalledOnce();
});
it('cancellation joins the creation promise and the late assigned disposer before return', async () => {
  const f = fixture();
  let release!: (value: typeof f.objects) => void;
  const creation = new Promise<typeof f.objects>((resolve) => {
    release = resolve;
  });
  vi.mocked(captureLocalRepositoryPreparationObjectData).mockReturnValue(creation as never);
  let done = false;
  const pending = withLocalRepositoryPreparationEnvelope(f.controller.signal, (envelope) =>
    executeLocalRepositoryPreparation(f.owners, { path: '/fixture' }, envelope),
  ).finally(() => {
    done = true;
  });
  const outcome = expect(pending).rejects.toThrow();
  await vi.waitFor(() =>
    expect(captureLocalRepositoryPreparationObjectData).toHaveBeenCalledOnce(),
  );
  f.controller.abort(Error('synthetic Stop'));
  await Promise.resolve();
  expect(done).toBe(false);
  release(f.objects);
  await outcome;
  expect(f.objects.dispose).toHaveBeenCalledOnce();
  expect(f.held.approve).not.toHaveBeenCalled();
  expect(f.held.materialize).not.toHaveBeenCalled();
});
it('does not outward-return a materialized receipt after cleanup revokes the original owner', async () => {
  const f = fixture();
  f.objects.dispose.mockImplementation(async () => {
    f.controller.abort(Error('synthetic owner close during cleanup'));
  });
  await expect(
    withLocalRepositoryPreparationEnvelope(f.controller.signal, (envelope) =>
      executeLocalRepositoryPreparation(f.owners, { path: '/fixture' }, envelope),
    ),
  ).rejects.toThrow();
  expect(f.held.materialize).toHaveBeenCalledOnce();
});
