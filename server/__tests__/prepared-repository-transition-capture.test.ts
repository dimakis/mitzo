import { afterEach, expect, it, vi } from 'vitest';
import { isDeepStrictEqual } from 'node:util';
import { capturePreparedRepositoryTransition } from '../prepared-repository-transition-capture.js';
import {
  preparedRepositoryCandidateFixture,
  qualifiedPreparedRepositoryRecord,
} from './prepared-repository-candidate-fixture.js';
import type { PreparedRepositoryTransitionCaptureOwners } from '../prepared-repository-transition.js';
import type { PreparedRepositoryBarrierReadScope } from '../prepared-repository-barrier-read.js';

const physical = vi.hoisted(() => ({ reader: vi.fn(), task: vi.fn() }));
vi.mock('../local-repository-native-read.js', () => ({
  capturePreparedRepositoryReader: physical.reader,
}));
vi.mock('../qualified-local-repository-task.js', async (original) => ({
  ...(await original<typeof import('../qualified-local-repository-task.js')>()),
  captureQualifiedLocalRepositoryTask: physical.task,
}));
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

/** Consumer ordering controls use a real bounded SQLite candidate and the real
 * DATA projection. Only the physical reader/task boundary is mocked here; these
 * records and callbacks do not qualify a native grant, actor or actual CAS. */
function fixture() {
  const f = preparedRepositoryCandidateFixture(cleanups);
  const record = qualifiedPreparedRepositoryRecord(f.pending(), f.input);
  record.qualifiedLocalPreparation!.publication = { version: 1, directories: [], files: [] };
  f.save(record);
  let live = true,
    queue = false;
  const scope: PreparedRepositoryBarrierReadScope = Object.freeze({
    bindingRevision: 'binding',
    profileRevision: 'profile',
    policyRevision: 'policy',
    readableRoots: Object.freeze(['/']),
    workspaceRoots: Object.freeze([]),
    deniedRoots: Object.freeze([]),
    signal: new AbortController().signal,
    assertCurrentSync() {
      expect(this).toBe(scope);
      if (!live) throw Error('owner changed');
    },
    async revalidate() {
      expect(this).toBe(scope);
      if (!live) throw Error('owner changed');
    },
  });
  const dispose = vi.fn(async () => {});
  physical.reader.mockImplementation(async (actual) => {
    expect(actual).toBe(scope);
    return {
      deniedRoots: [],
      deadline: Date.now() + 30000,
      assertReadable: async () => {},
      captureReadAnchor: vi.fn(),
      dispose,
    };
  });
  physical.task.mockImplementation(async () => {
    const task = structuredClone(record.pendingHostTask!.taskIdentity!);
    delete task.localSource;
    return task;
  });
  const owners: PreparedRepositoryTransitionCaptureOwners = {
    readScope: scope,
    assertNoQueuedOldWorkspaceCommandsSync() {
      expect(this).toBe(owners);
      if (queue) throw Error('queued old');
    },
    resultSha256(request) {
      expect(this).toBe(owners);
      expect(request).toEqual(record.pendingHostTask!.request);
      return 'f'.repeat(64);
    },
  };
  vi.spyOn(f.service, 'getOrdinaryWorkspaceForConversation').mockImplementation(
    () =>
      ({
        ...f.input.oldWorkspace,
        state: 'claimed',
        binding: f.input.binding,
        settings: { binding: record.pendingHostTask!.request.runtimeBinding },
      }) as never,
  );
  const cas = vi
    .spyOn(f.service, 'adoptPreparedRepositoryTransition')
    .mockImplementation((_facts, _child, guard) => {
      guard();
    });
  return {
    ...f,
    record,
    scope,
    owners,
    dispose,
    cas,
    revoke: () => {
      live = false;
    },
    enqueue: () => {
      queue = true;
    },
  };
}

it('captures frozen original full-row facts with the exact fresh owner and joined disposal, without adopting', async () => {
  const f = fixture();
  const before = f.db.prepare('SELECT record FROM repository_workspaces').get();
  const proof = (await f.service.capturePreparedRepositoryTransition(f.input, f.owners))!;
  expect(proof.facts.newWorkspace.taskIdentity).toEqual(f.record.pendingHostTask!.taskIdentity);
  expect(Object.isFrozen(proof.facts.request.runtimeBinding.execution)).toBe(true);
  expect(Object.isFrozen(proof.facts.newWorkspace.taskIdentity.root)).toBe(true);
  expect(physical.task).toHaveBeenCalledOnce();
  expect(f.dispose).toHaveBeenCalledOnce();
  expect(f.cas).not.toHaveBeenCalled();
  expect(f.db.prepare('SELECT record FROM repository_workspaces').get()).toEqual(before);
  proof.assertCurrentSync();
  await proof.revalidate();
  expect(physical.reader).toHaveBeenCalledTimes(2); // genuinely fresh physical owner/read each time
  expect(f.dispose).toHaveBeenCalledTimes(2);
});

it('returns no candidate without constructing a physical reader', async () => {
  const f = fixture();
  expect(
    await capturePreparedRepositoryTransition(
      f.service,
      { ...f.input, sourceTarget: { ...f.input.sourceTarget, turnId: 'absent' } },
      f.owners,
    ),
  ).toBeUndefined();
  expect(physical.reader).not.toHaveBeenCalled();
});

it.each(['publication', 'physical-task', 'result', 'raw-row', 'old-primary'] as const)(
  'refuses %s without a custody effect',
  async (change) => {
    const f = fixture();
    if (change === 'publication') {
      delete f.record.qualifiedLocalPreparation!.publication;
      f.save(f.record);
    }
    if (change === 'physical-task')
      physical.task.mockResolvedValue({
        ...f.record.pendingHostTask!.taskIdentity,
        root: { dev: 9, ino: 9 },
      });
    if (change === 'result') f.owners.resultSha256 = () => 'invalid';
    if (change === 'raw-row')
      physical.task.mockImplementation(async () => {
        f.save({ ...f.record, createdAt: 99 });
        return f.record.pendingHostTask!.taskIdentity;
      });
    if (change === 'old-primary')
      vi.mocked(f.service.getOrdinaryWorkspaceForConversation).mockReturnValue(undefined);
    await expect(
      capturePreparedRepositoryTransition(f.service, f.input, f.owners),
    ).rejects.toThrow();
    expect(f.cas).not.toHaveBeenCalled();
  },
);

it.each(['task-await', 'dispose', 'queue'] as const)(
  'refuses owner drift during %s before returning a capability',
  async (point) => {
    const f = fixture();
    if (point === 'task-await')
      physical.task.mockImplementation(async () => {
        f.revoke();
        return f.record.pendingHostTask!.taskIdentity;
      });
    if (point === 'dispose')
      f.dispose.mockImplementation(async () => {
        f.revoke();
      });
    if (point === 'queue')
      f.dispose.mockImplementation(async () => {
        f.enqueue();
      });
    await expect(
      capturePreparedRepositoryTransition(f.service, f.input, f.owners),
    ).rejects.toThrow();
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(f.cas).not.toHaveBeenCalled();
  },
);

it('rechecks fresh physical data then the same scope/no-queue guard immediately inside the one-shot custody CAS', async () => {
  const f = fixture();
  const proof = (await capturePreparedRepositoryTransition(f.service, f.input, f.owners))!;
  f.cas.mockImplementation((facts, child, guard) => {
    expect(isDeepStrictEqual(facts, proof.facts)).toBe(true);
    expect(child).toBe('child');
    f.enqueue();
    guard();
  });
  await expect(proof.adopt('child')).rejects.toThrow();
  expect(physical.reader).toHaveBeenCalledTimes(2);
  expect(f.cas).toHaveBeenCalledOnce();
  await expect(proof.adopt('child')).rejects.toThrow();
  expect(f.cas).toHaveBeenCalledOnce();
  expect(() => proof.assertCurrentSync()).toThrow();
});

it('closes the pre-CAS capability after a successful custody call and never replays it', async () => {
  const f = fixture();
  const proof = (await capturePreparedRepositoryTransition(f.service, f.input, f.owners))!;
  await proof.adopt('child');
  expect(f.cas).toHaveBeenCalledOnce();
  expect(() => proof.assertCurrentSync()).toThrow();
  await expect(proof.revalidate()).rejects.toThrow();
  await expect(proof.adopt('child')).rejects.toThrow();
});

it.each(['getter', 'promise', 'false', 'borrowed-call', 'changed-scope'] as const)(
  'rejects malformed or drifting retained owner %s without fallback',
  async (change) => {
    const f = fixture();
    const getter = vi.fn(() => f.scope);
    if (change === 'getter') Object.defineProperty(f.owners, 'readScope', { get: getter });
    if (change === 'promise')
      f.owners.assertNoQueuedOldWorkspaceCommandsSync = (() => Promise.resolve()) as never;
    if (change === 'false')
      f.owners.assertNoQueuedOldWorkspaceCommandsSync = (() => false) as never;
    if (change === 'borrowed-call')
      Object.assign(f.owners.assertNoQueuedOldWorkspaceCommandsSync, { call: () => {} });
    if (change === 'borrowed-call') f.enqueue();
    if (change === 'changed-scope')
      f.dispose.mockImplementation(async () => {
        Object.assign(f.owners, { readScope: { ...f.scope } });
      });
    await expect(
      capturePreparedRepositoryTransition(f.service, f.input, f.owners),
    ).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(f.cas).not.toHaveBeenCalled();
  },
);

it('joins in-flight reader disposal before publishing success or entering custody', async () => {
  const f = fixture();
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const disposing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.dispose.mockImplementation(async () => {
    entered();
    await waiting;
  });
  let resolved = false;
  const pending = capturePreparedRepositoryTransition(f.service, f.input, f.owners).then(
    (value) => {
      resolved = true;
      return value;
    },
  );
  await disposing;
  expect(resolved).toBe(false);
  expect(f.cas).not.toHaveBeenCalled();
  release();
  await pending;
  expect(resolved).toBe(true);
});

it('refuses queue callbacks that revoke the original scope synchronously, including at the final boundary', async () => {
  const f = fixture();
  f.owners.assertNoQueuedOldWorkspaceCommandsSync = () => {
    f.revoke();
  };
  await expect(capturePreparedRepositoryTransition(f.service, f.input, f.owners)).rejects.toThrow();
  expect(physical.reader).not.toHaveBeenCalled();
  expect(f.cas).not.toHaveBeenCalled();
});

it('captures input DATA before awaiting and refuses accessors without invoking them', async () => {
  const f = fixture();
  const getter = vi.fn(() => f.input.oldWorkspace);
  Object.defineProperty(f.input, 'oldWorkspace', { get: getter });
  await expect(capturePreparedRepositoryTransition(f.service, f.input, f.owners)).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(physical.reader).not.toHaveBeenCalled();
});

it('reserves one adoption attempt before internal waits and rejects a concurrent child without a second reader', async () => {
  const f = fixture();
  const proof = (await capturePreparedRepositoryTransition(f.service, f.input, f.owners))!;
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  physical.task.mockImplementation(async () => {
    entered();
    await waiting;
    return f.record.pendingHostTask!.taskIdentity;
  });
  const first = proof.adopt('child');
  await reading;
  await expect(proof.adopt('other')).rejects.toThrow();
  expect(physical.reader).toHaveBeenCalledTimes(2);
  release();
  await first;
  expect(f.cas).toHaveBeenCalledOnce();
});
