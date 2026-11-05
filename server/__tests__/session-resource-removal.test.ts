import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SessionRemovalStore } from '../../packages/protocol/src/session-removal-store.js';
import { SessionResourceRemovalService } from '../session-resource-removal.js';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((close) => close()));
function fixture() {
  const db = new Database(':memory:');
  cleanup.push(() => db.close());
  const store = new SessionRemovalStore(db);
  const calls: string[] = [];
  const deps = {
    store,
    fingerprint: vi.fn(() => 'exact-resources'),
    assertProtected: vi.fn(() => {}),
    cancelPrompts: vi.fn(async () => {
      calls.push('timers');
    }),
    closeRuntime: vi.fn(async () => {
      expect(() => store.assertAdmissible('chat')).toThrow(/remov/);
      calls.push('close');
    }),
    assertSettled: vi.fn(() => {}),
  };
  const service = new SessionResourceRemovalService(deps);
  const current = vi.fn(() => {});
  return { service, store, deps, current, calls };
}
it('fences before stopping timers/runtime and coalesces simultaneous preparation', async () => {
  const f = fixture();
  const [first, second] = await Promise.all([
    f.service.prepare('chat', f.current),
    f.service.prepare('chat', f.current),
  ]);
  expect(first.operationId).toBe(second.operationId);
  expect(f.calls).toEqual(['timers', 'close']);
  expect(first.phase).toBe('closing');
});
it('keeps failed shutdown visible and fenced; an explicit keep action releases only the admission fence', async () => {
  const f = fixture();
  f.deps.closeRuntime.mockRejectedValueOnce(Error('unsettled tool'));
  await expect(f.service.prepare('chat', f.current)).rejects.toThrow(/unsettled/);
  const record = f.store.read('chat')!;
  expect(record.phase).toBe('failed');
  expect(() => f.store.assertAdmissible('chat')).toThrow();
  f.service.keep('chat', record.operationId, f.current);
  expect(() => f.store.assertAdmissible('chat')).not.toThrow();
});
it('rechecks authority and resources before release and never clears uncertainty after release starts', async () => {
  const f = fixture();
  const record = await f.service.prepare('chat', f.current);
  const release = vi.fn(async () => {
    throw Error('delete outcome unknown');
  });
  await expect(f.service.release('chat', record.operationId, f.current, release)).rejects.toThrow(
    /unknown/,
  );
  expect(f.store.read('chat')?.phase).toBe('failed');
  expect(() => f.service.keep('chat', record.operationId, f.current)).toThrow(/release/);
  f.deps.fingerprint.mockReturnValue('replacement');
  await expect(f.service.release('chat', record.operationId, f.current, release)).rejects.toThrow(
    /changed/,
  );
  expect(release).toHaveBeenCalledTimes(1);
});
it('checks revocation after asynchronous shutdown and protects shared work before fencing', async () => {
  const f = fixture();
  f.deps.assertProtected.mockImplementationOnce(() => {
    throw Error('shared owner');
  });
  await expect(f.service.prepare('chat', f.current)).rejects.toThrow(/shared/);
  expect(f.store.read('chat')).toBeUndefined();
  f.deps.closeRuntime.mockImplementationOnce(async () => {
    f.current.mockImplementation(() => {
      throw Error('revoked');
    });
  });
  await expect(f.service.prepare('chat', f.current)).rejects.toThrow(/revoked/);
  expect(f.store.read('chat')?.phase).toBe('failed');
});
it('records successful release once and allows exact receipt recovery after response loss', async () => {
  const f = fixture();
  const record = await f.service.prepare('chat', f.current);
  const release = vi.fn(async () => {});
  await f.service.release('chat', record.operationId, f.current, release);
  await f.service.release('chat', record.operationId, f.current, release);
  expect(release).toHaveBeenCalledTimes(1);
  expect(f.store.read('chat')?.phase).toBe('completed');
});
it('joins an in-flight preparation before a concurrent deletion can release resources', async () => {
  const f = fixture();
  let finish!: () => void;
  f.deps.cancelPrompts.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  const preparation = f.service.prepare('chat', f.current);
  const operationId = f.store.read('chat')!.operationId;
  const release = vi.fn(async () => {});
  const deletion = f.service.release('chat', operationId, f.current, release);
  await Promise.resolve();
  expect(release).not.toHaveBeenCalled();
  finish();
  await Promise.all([preparation, deletion]);
  expect(release).toHaveBeenCalledTimes(1);
  expect(f.calls).toEqual(['close']);
});

it('requires durable preparation completion after an interrupted controller', async () => {
  const f = fixture();
  const record = f.store.begin('chat', 'interrupted', 'exact-resources');
  const restarted = new SessionResourceRemovalService(f.deps);
  const release = vi.fn(async () => {});
  expect(restarted.isPrepared('chat')).toBe(false);
  await expect(restarted.release('chat', record.operationId, f.current, release)).rejects.toThrow(
    /prepar|review/i,
  );
  expect(release).not.toHaveBeenCalled();
  await restarted.prepare('chat', f.current);
  expect(restarted.isPrepared('chat')).toBe(true);
  const recovered = new SessionResourceRemovalService(f.deps);
  expect(recovered.isPrepared('chat')).toBe(true);
  await recovered.release('chat', record.operationId, f.current, release);
  expect(f.calls).toEqual(['timers', 'close']);
  expect(release).toHaveBeenCalledTimes(1);
});

it('cannot release a failed preparation until prompt cancellation has been retried', async () => {
  const f = fixture();
  f.deps.cancelPrompts.mockRejectedValueOnce(Error('delivery uncertain'));
  await expect(f.service.prepare('chat', f.current)).rejects.toThrow(/uncertain/);
  const record = f.store.read('chat')!;
  const release = vi.fn(async () => {});
  await expect(f.service.release('chat', record.operationId, f.current, release)).rejects.toThrow(
    /prepar|review/i,
  );
  expect(release).not.toHaveBeenCalled();
  await f.service.prepare('chat', f.current);
  await f.service.release('chat', record.operationId, f.current, release);
  expect(f.deps.cancelPrompts).toHaveBeenCalledTimes(2);
  expect(release).toHaveBeenCalledTimes(1);
});
