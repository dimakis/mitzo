import { expect, it, vi } from 'vitest';
import {
  SynchronousStageProfiler,
  installSynchronousStage,
  NativeReadBoundaryProfile,
  installSignedNativeReadStages,
} from './fixtures/synchronous-stage-profiler.js';
import { FrozenHostCodexBootstrapAuthority } from '../frozen-host-codex-bootstrap.js';
import { OrdinaryLocalCodexSelectionOwner } from '../ordinary-local-codex-selection-owner.js';
import { OrdinaryLocalWorkspaceOwner } from '../ordinary-local-workspace-owner.js';
import { PreparedRepositoryWorkspaceOwner } from '../prepared-repository-workspace-owner.js';
import { RepositoryWorkspaces } from '../repository-workspaces.js';
import * as accountProfiles from '../account-profiles.js';
import * as nativeReaders from '../local-repository-native-read.js';

it('separates inclusive, exclusive and recursive time without double counting nested stages', () => {
  let time = 0;
  const p = new SynchronousStageProfiler(() => time);
  const child = p.wrap('child', () => {
    time += 2;
  });
  const parent = p.wrap('parent', () => {
    time++;
    child();
    time += 4;
  });
  parent();
  const stats = p.snapshot();
  expect(stats.instrumentedMs).toBe(7);
  expect(stats.stages.parent).toMatchObject({ calls: 1, inclusiveMs: 7, exclusiveMs: 5 });
  expect(stats.stages.child).toMatchObject({ calls: 1, inclusiveMs: 2, exclusiveMs: 2 });
  p.reset();
  time = 0;
  const recursive = p.wrap('recursive', (depth: number): void => {
    time++;
    if (depth) recursive(depth - 1);
    time++;
  });
  recursive(1);
  expect(p.snapshot()).toMatchObject({
    instrumentedMs: 4,
    stages: {
      recursive: {
        calls: 2,
        outermostCalls: 1,
        recursiveCalls: 1,
        maxRecursionDepth: 2,
        inclusiveMs: 6,
        exclusiveMs: 4,
      },
    },
  });
});

it('preserves receiver, arguments, return and exception identity without inspecting values or adding awaits', async () => {
  const p = new SynchronousStageProfiler();
  const receiver = {},
    argument = { privateValue: 'must-not-appear' },
    result = { privateValue: 'must-not-appear' },
    error = Error('must-not-appear');
  const call = p.wrap('call', function (this: unknown, value: unknown) {
    expect(this).toBe(receiver);
    expect(value).toBe(argument);
    return result;
  });
  expect(Reflect.apply(call, receiver, [argument])).toBe(result);
  const throws = p.wrap('throw', () => {
    throw error;
  });
  let caught: unknown;
  try {
    throws();
  } catch (value) {
    caught = value;
  }
  expect(caught).toBe(error);
  expect(JSON.stringify(p.snapshot())).not.toContain('must-not-appear');
  const promise = Promise.resolve(result);
  const asyncReturn = p.wrap('promise-entry', () => promise);
  expect(asyncReturn()).toBe(promise);
  p.reset();
  expect(await promise).toBe(result);
  expect(p.snapshot().stages).toEqual({});
});

it('installs every real stage before construction without invoking owners and restores exact original exports', () => {
  const p = new SynchronousStageProfiler();
  const original = Object.getOwnPropertyDescriptor(
    FrozenHostCodexBootstrapAuthority.prototype,
    'assertSync',
  )!.value;
  const load = accountProfiles.loadAccountProfiles;
  const capture = nativeReaders.captureNativeLocalRepositoryReader;
  const workspaceMethods = [
    [OrdinaryLocalCodexSelectionOwner.prototype, 'assertCurrentSync'],
    [OrdinaryLocalCodexSelectionOwner.prototype, 'preparedPrimary'],
    [OrdinaryLocalCodexSelectionOwner.prototype, 'assertPreparedPrimary'],
    [OrdinaryLocalCodexSelectionOwner.prototype, 'assertToolCurrent'],
    [OrdinaryLocalWorkspaceOwner.prototype, 'assertCurrentSync'],
    [OrdinaryLocalWorkspaceOwner.prototype, 'get'],
    [PreparedRepositoryWorkspaceOwner.prototype, 'assertCurrentSync'],
    [PreparedRepositoryWorkspaceOwner.prototype, 'get'],
    [RepositoryWorkspaces.prototype, 'assertPreparedRepositoryTransitionAdopted'],
    [RepositoryWorkspaces.prototype, 'getHostReservation'],
    [RepositoryWorkspaces.prototype, 'snapshotHostInput'],
    [RepositoryWorkspaces.prototype, 'getHostRecord'],
    [RepositoryWorkspaces.prototype, 'getForConversation'],
    [RepositoryWorkspaces.prototype, 'validateHostTask'],
  ].map(([target, key]) => ({
    target: target as object,
    key: key as string,
    original: Object.getOwnPropertyDescriptor(target, key as string)!.value,
  }));
  const restore = installSignedNativeReadStages(p, new NativeReadBoundaryProfile());
  try {
    const current = Object.getOwnPropertyDescriptor(
      FrozenHostCodexBootstrapAuthority.prototype,
      'assertSync',
    )!.value;
    expect(current).not.toBe(original);
    expect(vi.isMockFunction(current)).toBe(false);
    expect(vi.isMockFunction(accountProfiles.loadAccountProfiles)).toBe(true);
    expect(vi.isMockFunction(nativeReaders.captureNativeLocalRepositoryReader)).toBe(true);
    for (const { target, key, original } of workspaceMethods) {
      const wrapped = Object.getOwnPropertyDescriptor(target, key)!.value;
      expect(wrapped).not.toBe(original);
      expect(vi.isMockFunction(wrapped)).toBe(false);
    }
    expect(p.snapshot().stages).toEqual({});
  } finally {
    restore();
  }
  expect(
    Object.getOwnPropertyDescriptor(FrozenHostCodexBootstrapAuthority.prototype, 'assertSync')!
      .value,
  ).toBe(original);
  expect(accountProfiles.loadAccountProfiles).toBe(load);
  expect(nativeReaders.captureNativeLocalRepositoryReader).toBe(capture);
  for (const { target, key, original } of workspaceMethods)
    expect(Object.getOwnPropertyDescriptor(target, key)!.value).toBe(original);
});

it('observes malformed reader options without interfering with the original call or Promise identity', () => {
  const descriptor = Object.getOwnPropertyDescriptor(
    nativeReaders,
    'captureNativeLocalRepositoryReader',
  )!;
  const promise = Promise.resolve(null);
  const calls: Array<{ receiver: unknown; args: unknown[] }> = [];
  const original = function (this: unknown, ...args: unknown[]) {
    calls.push({ receiver: this, args });
    return promise;
  };
  Object.defineProperty(nativeReaders, 'captureNativeLocalRepositoryReader', {
    configurable: true,
    writable: true,
    value: original,
  });
  let restore: (() => void) | undefined;
  try {
    const boundaries = new NativeReadBoundaryProfile();
    restore = installSignedNativeReadStages(new SynchronousStageProfiler(), boundaries);
    const receiver = {},
      context = {};
    const trap = vi.fn(() => {
      throw Error('must-not-appear');
    });
    const proxy = new Proxy({}, { getOwnPropertyDescriptor: trap });
    for (const options of [undefined, null, proxy]) {
      expect(
        Reflect.apply(nativeReaders.captureNativeLocalRepositoryReader, receiver, [
          context,
          options,
        ]),
      ).toBe(promise);
      expect(calls.at(-1)!.receiver).toBe(receiver);
      expect(calls.at(-1)!.args[0]).toBe(context);
      expect(calls.at(-1)!.args[1]).toBe(options);
    }
    expect(calls).toHaveLength(3);
    expect(trap).toHaveBeenCalledTimes(1);
    expect(boundaries.snapshot().readerEntries).toEqual([]);
    expect(JSON.stringify(boundaries.snapshot())).not.toContain('must-not-appear');
  } finally {
    restore?.();
    Object.defineProperty(nativeReaders, 'captureNativeLocalRepositoryReader', descriptor);
  }
});

it('installs plain prototype wrappers before an instance spy captures its original method and restores inherited descriptors', () => {
  const p = new SynchronousStageProfiler();
  class Base {
    current() {
      return this;
    }
  }
  class Child extends Base {}
  const restore = installSynchronousStage(p, Child.prototype, 'current', 'current');
  const instance = new Child();
  const original = instance.current;
  const spy = vi.spyOn(instance, 'current').mockImplementation(function (this: Child) {
    return Reflect.apply(original, this, []);
  });
  try {
    expect(instance.current()).toBe(instance);
    expect(p.snapshot().stages.current.calls).toBe(1);
  } finally {
    spy.mockRestore();
    restore();
  }
  expect(Object.hasOwn(Child.prototype, 'current')).toBe(false);
  expect(instance.current()).toBe(instance);
});

it('refuses instrumentation getters and active-stack reset without changing the original failure', () => {
  const p = new SynchronousStageProfiler();
  const getter = vi.fn(() => () => {});
  const object = Object.defineProperty({}, 'current', { get: getter });
  expect(() => installSynchronousStage(p, object, 'current', 'current')).toThrow();
  expect(getter).not.toHaveBeenCalled();
  const reset = p.wrap('reset', () => p.reset());
  expect(() => reset()).toThrow();
  expect(p.snapshot().stages.reset.calls).toBe(1);
});

it('classifies call-entry windows and bounds helper marks without retaining inputs or absolute timestamps', () => {
  let clock = 100,
    wall = 1000;
  const boundary = new NativeReadBoundaryProfile(
    () => clock,
    () => wall,
  );
  const p = new SynchronousStageProfiler(
    () => clock,
    (time) => boundary.windowAt(time),
  );
  p.wrap('before', () => {
    clock += 2;
  })();
  boundary.readerEntry(1010);
  p.wrap('inside', () => {
    clock += 3;
  })();
  const finish = boundary.beginHelper();
  clock += 4;
  wall += 4;
  finish(true);
  clock = 115;
  wall = 1015;
  p.wrap('late', () => {
    clock++;
  })();
  expect(p.snapshot().windows['before-reader'].stages.before.calls).toBe(1);
  expect(p.snapshot().windows['reader-budget'].stages.inside.calls).toBe(1);
  expect(p.snapshot().windows['after-deadline'].stages.late.calls).toBe(1);
  expect(boundary.snapshot()).toMatchObject({
    readerEntries: [{ elapsedMs: 2, deadlineRemainingMs: 10 }],
    helpers: [{ startedMs: 5, endedMs: 9, elapsedMs: 4, success: true }],
  });
  for (let i = 0; i < 20; i++) boundary.beginHelper()(false);
  expect(boundary.snapshot().helpers).toHaveLength(12);
  expect(boundary.snapshot().droppedHelpers).toBe(9);
  boundary.reset();
  expect(boundary.snapshot().helpers).toEqual([]);
});
