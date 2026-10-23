import { expect, it, vi } from 'vitest';
import { codexNativeExecutionPolicy } from '../codex-native-execution-policy.js';
import { withPreparedRepositoryBarrierReadScope } from '../prepared-repository-barrier-read.js';

function fixture() {
  let current = true;
  const policy = codexNativeExecutionPolicy({
    bindingRevision: 'actual-binding',
    mode: 'agent',
    cwd: '/old-task',
    readableRoots: ['/selected-read'],
    writableRoots: ['/old-task'],
    deniedRoots: ['/credentials'],
    writeProtectedRoots: [],
  });
  const owners: Parameters<typeof withPreparedRepositoryBarrierReadScope>[2] = {
    signal: new AbortController().signal,
    selectedPolicy: () => policy,
    assertCurrentSync: vi.fn(() => {
      if (!current) throw Error('Owner changed');
    }),
    revalidate: vi.fn(async () => {}),
    assertNativeExecutionCurrent: vi.fn((_policy: typeof policy, _commandId: string) => {}),
  };
  return {
    policy,
    owners,
    revoke: () => {
      current = false;
    },
  };
}

it('supplies a fresh selected read ceiling with an independent barrier lifetime', async () => {
  const f = fixture();
  let retained!: Parameters<Parameters<typeof withPreparedRepositoryBarrierReadScope>[3]>[0];
  await withPreparedRepositoryBarrierReadScope(f.policy, 'original', f.owners, async (scope) => {
    retained = scope;
    expect(Object.isFrozen(scope)).toBe(true);
    expect(Object.isFrozen(scope.readableRoots)).toBe(true);
    expect(scope.readableRoots).toEqual(['/selected-read']);
    expect(scope.workspaceRoots).toEqual(['/old-task']);
    expect(scope.deniedRoots).toEqual(['/credentials']);
    expect(scope).not.toHaveProperty('nativeTarget');
    expect(scope).not.toHaveProperty('callId');
    expect(scope.signal.aborted).toBe(false);
    await scope.revalidate();
    expect(f.owners.assertNativeExecutionCurrent).toHaveBeenCalledWith(f.policy, 'original');
  });
  expect(retained.signal.aborted).toBe(true);
  expect(() => retained.assertCurrentSync()).toThrow();
});

it('refuses absent policy without inferring a read grant or invoking the action', async () => {
  const f = fixture(),
    action = vi.fn();
  await expect(
    withPreparedRepositoryBarrierReadScope(undefined, 'original', f.owners, action),
  ).rejects.toThrow();
  expect(action).not.toHaveBeenCalled();
});

it('checks old owner and selected policy across async revalidation', async () => {
  const f = fixture();
  f.owners.revalidate = vi.fn(async () => {
    f.revoke();
  });
  await expect(
    withPreparedRepositoryBarrierReadScope(f.policy, 'original', f.owners, async (scope) =>
      scope.revalidate(),
    ),
  ).rejects.toThrow();
});

it('refuses a value returned by asynchronous current-owner validation', async () => {
  const f = fixture();
  f.owners.revalidate = (async () => false) as unknown as typeof f.owners.revalidate;
  await expect(
    withPreparedRepositoryBarrierReadScope(f.policy, 'original', f.owners, async (scope) =>
      scope.revalidate(),
    ),
  ).rejects.toThrow();
});

it('rejects current-policy owner replacement and preserves method receiver', async () => {
  const f = fixture();
  f.owners.assertNativeExecutionCurrent = function (policy) {
    expect(this).toBe(f.owners);
    expect(policy).toBe(f.policy);
  };
  await withPreparedRepositoryBarrierReadScope(f.policy, 'original', f.owners, async (scope) => {
    scope.assertCurrentSync();
    f.owners.assertNativeExecutionCurrent = () => {};
    expect(() => scope.assertCurrentSync()).toThrow();
  });
});

it.each([() => 1, () => Promise.resolve(), () => Promise.reject(Error('Async denial'))])(
  'rejects non-undefined synchronous proof %j',
  async (makeValue) => {
    const f = fixture();
    f.owners.assertNativeExecutionCurrent = makeValue as NonNullable<
      typeof f.owners.assertNativeExecutionCurrent
    >;
    await expect(
      withPreparedRepositoryBarrierReadScope(f.policy, 'original', f.owners, vi.fn()),
    ).rejects.toThrow();
  },
);

it('refuses changed roots even if a replacement selected policy repeats revision strings', async () => {
  const f = fixture();
  let selected = f.policy;
  f.owners.selectedPolicy = () => selected;
  await withPreparedRepositoryBarrierReadScope(f.policy, 'original', f.owners, async (scope) => {
    selected = Object.freeze({ ...f.policy, readableRoots: Object.freeze(['/']) });
    expect(() => scope.assertCurrentSync()).toThrow();
  });
});

it('expires after action failure and session abort without retaining callback authority', async () => {
  const f = fixture(),
    controller = new AbortController();
  f.owners.signal = controller.signal;
  await expect(
    withPreparedRepositoryBarrierReadScope(f.policy, 'original', f.owners, async (scope) => {
      controller.abort();
      expect(() => scope.assertCurrentSync()).toThrow();
      throw Error('Reconcile');
    }),
  ).rejects.toThrow('Reconcile');
});
