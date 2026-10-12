import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import type { AccountBinding } from '@mitzo/protocol';
import { RepositoryWorkspaces, publicRepositoryWorkspace } from '../repository-workspaces.js';

// Disposable Git/SQLite fixtures only. No backend, account sign-in or model call.
const sourceReads = vi.hoisted(() => vi.fn());
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: (...args: Parameters<typeof actual.open>) => {
      sourceReads(...args);
      return actual.open(...args);
    },
  };
});
const copy = vi.hoisted(() => ({
  calls: vi.fn(),
  before: undefined as (() => Promise<void>) | undefined,
}));
vi.mock('../repository-task-copy.js', async (original) => {
  const actual = await original<typeof import('../repository-task-copy.js')>();
  return {
    ...actual,
    copyRepositoryTaskCheckout: async (
      ...args: Parameters<typeof actual.copyRepositoryTaskCheckout>
    ) => {
      copy.calls(...args);
      await copy.before?.();
      return actual.copyRepositoryTaskCheckout(...args);
    },
  };
});
const roots: string[] = [];
const services = new Set<RepositoryWorkspaces>();
const binding: AccountBinding = {
  accountId: 'offline-account',
  accountLabel: 'Offline',
  provider: 'openai-codex',
  model: 'fixture-model',
  profileRevision: 'profile-1',
};
afterEach(async () => {
  copy.before = undefined;
  copy.calls.mockClear();
  sourceReads.mockClear();
  for (const service of services) service.close();
  services.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-workspace-reservation-')));
  roots.push(root);
  const source = join(root, 'source');
  const git = (directory: string, ...args: string[]) =>
    execFileSync(
      'git',
      ['-C', directory, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
        },
      },
    ).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', source]);
  git(source, 'config', 'user.name', 'Offline fixture');
  git(source, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(source, 'task.txt'), 'accepted source');
  git(source, 'add', 'task.txt');
  git(source, 'commit', '-qm', 'offline base');
  const oid = git(source, 'rev-parse', 'HEAD');
  const authorize = vi.fn(
    async (
      _binding: AccountBinding,
      _connection: string,
      _repository: string,
      _signal: AbortSignal,
    ) => ({ revision: 1, allowedBaseBranches: ['main'] }),
  );
  const inspect = vi.fn(async () => ({
    repository: 'example/repo',
    baseBranch: 'main',
    baseOid: oid,
  }));
  const prepare = vi.fn(async (_preview: unknown, directory: string, featureBranch: string) => {
    await cp(source, directory, { recursive: true });
    git(directory, 'checkout', '-qb', featureBranch);
    return { ...(await inspect()), directory, featureBranch };
  });
  const verify = vi.fn(async () => {});
  const privateRoot = join(root, 'private');
  const open = () => {
    const service = new RepositoryWorkspaces(privateRoot, { authorize, inspect, prepare, verify });
    services.add(service);
    return service;
  };
  const service = open();
  const taskRoot = join(root, 'tasks');
  await mkdir(taskRoot, { mode: 0o700 });
  const ready = async () => {
    const signal = new AbortController().signal;
    const preview = await service.preview(binding, 'connection', 'example/repo', signal);
    return service.prepare(preview.id, binding, signal);
  };
  const prepared = await ready();
  const input = {
    id: prepared.id,
    binding: structuredClone(binding),
    conversationId: 'conversation-1',
    taskRoot,
    signal: new AbortController().signal,
  };
  return {
    root,
    privateRoot,
    taskRoot,
    service,
    open,
    ready,
    input,
    authorize,
    verify,
    inspect,
    git,
    source,
  };
}

describe('durable host workspace reservation', () => {
  it('persists exact routing metadata before any task mkdir/copy and keeps public status non-ready', async () => {
    const f = await fixture();
    const result = await f.service.reserveHostTask(f.input);
    expect(result).toMatchObject({
      id: f.input.id,
      binding,
      conversationId: f.input.conversationId,
      sandbox: false,
      state: 'reserved',
      directory: join(f.taskRoot, `repo-${f.input.id}`, 'mgmt'),
      hostReservation: { version: 1, taskRoot: f.taskRoot },
    });
    expect(f.service.getHostReservation(f.input)).toEqual(result);
    expect(publicRepositoryWorkspace(f.service.get(f.input.id))).toMatchObject({
      state: 'claiming',
    });
    expect(publicRepositoryWorkspace(f.service.get(f.input.id))).not.toHaveProperty(
      'conversationId',
    );
    expect(result).not.toHaveProperty('seed');
    expect(result).not.toHaveProperty('taskIdentity');
    expect(f.service.status(f.input.id, binding)).toMatchObject({ state: 'claiming' });
    expect(f.service.status(f.input.id, binding)).not.toHaveProperty('directory');
    expect(() => f.service.getForConversation(f.input.conversationId)).toThrow();
    await expect(access(join(f.taskRoot, `repo-${f.input.id}`))).rejects.toThrow();
    expect(copy.calls).not.toHaveBeenCalled();
    await expect(
      f.service.claim(f.input.id, binding, f.input.conversationId, f.taskRoot, false),
    ).rejects.toThrow();
    await expect(f.service.discard(f.input.id, binding)).rejects.toThrow();
    await expect(
      f.service.releaseSource(f.input.id, binding, f.input.conversationId),
    ).rejects.toThrow();
  });
  it('preserves reserved identity on exact retries and cold reopen without effects', async () => {
    const f = await fixture();
    const first = await f.service.reserveHostTask(f.input);
    expect(await f.service.reserveHostTask(f.input)).toEqual(first);
    f.service.close();
    services.delete(f.service);
    const cold = f.open();
    expect(cold.getHostReservation(f.input)).toEqual(first);
    expect(await cold.reserveHostTask(f.input)).toEqual(first);
    expect(copy.calls).not.toHaveBeenCalled();
  });
  it.each(['conversation', 'root', 'account', 'profile', 'model'] as const)(
    'rejects changed %s retry before effects',
    async (field) => {
      const f = await fixture();
      const original = await f.service.reserveHostTask(f.input);
      const changed = { ...f.input, binding: { ...binding } };
      if (field === 'conversation') changed.conversationId = 'other';
      if (field === 'root') {
        changed.taskRoot = join(f.root, 'other-tasks');
        await mkdir(changed.taskRoot);
      }
      if (field === 'account') changed.binding.accountId = 'other';
      if (field === 'profile') changed.binding.profileRevision = 'other';
      if (field === 'model') changed.binding.model = 'other';
      await expect(f.service.reserveHostTask(changed)).rejects.toThrow();
      expect(f.service.getHostReservation(f.input)).toEqual(original);
      expect(copy.calls).not.toHaveBeenCalled();
    },
  );
  it('serializes two-store exact reservations and conflicting conversation owners', async () => {
    const f = await fixture();
    const second = f.open();
    const exact = await Promise.all([
      f.service.reserveHostTask(f.input),
      second.reserveHostTask(f.input),
    ]);
    expect(exact[0]).toEqual(exact[1]);
    await expect(second.reserveHostTask({ ...f.input, conversationId: 'other' })).rejects.toThrow();
    expect(copy.calls).not.toHaveBeenCalled();
  });
  it('converges an exact reservation after another store wins during source verification', async () => {
    const f = await fixture();
    const second = f.open();
    const entered = deferred();
    const gate = deferred();
    f.verify.mockImplementationOnce(async () => {
      entered.release();
      await gate.promise;
    });
    const first = f.service.reserveHostTask(f.input);
    const outcome = first.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await entered.promise;
    const winner = await second.reserveHostTask(f.input);
    gate.release();
    expect(await outcome).toEqual({ ok: true, value: winner });
    expect(copy.calls).not.toHaveBeenCalled();
  });
  it('allows exactly one simultaneous conflicting reservation across two stores', async () => {
    const f = await fixture();
    const second = f.open();
    const outcomes = await Promise.allSettled([
      f.service.reserveHostTask(f.input),
      second.reserveHostTask({ ...f.input, conversationId: 'competing-owner' }),
    ]);
    expect(outcomes.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((value) => value.status === 'rejected')).toHaveLength(1);
    expect(copy.calls).not.toHaveBeenCalled();
  });
  it('enforces global conversation uniqueness across separate prepared records', async () => {
    const f = await fixture();
    const second = f.open();
    const other = await f.ready();
    const outcomes = await Promise.allSettled([
      f.service.reserveHostTask(f.input),
      second.reserveHostTask({ ...f.input, id: other.id }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect(copy.calls).not.toHaveBeenCalled();
  });
  it('persists uncertainty before copying and allows only one two-store materialization', async () => {
    const f = await fixture();
    const second = f.open();
    await f.service.reserveHostTask(f.input);
    const gate = deferred();
    copy.before = async () => {
      expect(second.getHostReservation(f.input)).toMatchObject({
        state: 'claiming',
        conversationId: f.input.conversationId,
      });
      await gate.promise;
    };
    const first = f.service.claimReservedHostTask(f.input);
    await vi.waitFor(() => expect(copy.calls).toHaveBeenCalledTimes(1));
    await expect(second.claimReservedHostTask(f.input)).rejects.toThrow();
    gate.release();
    const claimed = await first;
    expect(claimed).toMatchObject({ state: 'claimed', conversationId: f.input.conversationId });
    expect(await readFile(join(claimed.directory!, 'task.txt'), 'utf8')).toBe('accepted source');
    expect(copy.calls).toHaveBeenCalledTimes(1);
    expect(second.getForConversation(f.input.conversationId)?.directory).toBe(claimed.directory);
  });
  it('retains uncertain failed copy across restart and refuses replay or cleanup', async () => {
    const f = await fixture();
    await f.service.reserveHostTask(f.input);
    copy.before = async () => {
      throw new Error('offline uncertain copy');
    };
    await expect(f.service.claimReservedHostTask(f.input)).rejects.toThrow();
    f.service.close();
    services.delete(f.service);
    const cold = f.open();
    expect(cold.getHostReservation(f.input)).toMatchObject({ state: 'claiming' });
    await expect(cold.claimReservedHostTask(f.input)).rejects.toThrow();
    await expect(cold.discard(f.input.id, binding)).rejects.toThrow();
    expect(copy.calls).toHaveBeenCalledTimes(1);
  });
  it('preserves a colliding destination and never clears it to replay a claim', async () => {
    const f = await fixture();
    const reserved = await f.service.reserveHostTask(f.input);
    await mkdir(reserved.directory, { recursive: true });
    await writeFile(join(reserved.directory, 'task.txt'), 'preexisting retained data');
    await expect(f.service.claimReservedHostTask(f.input)).rejects.toThrow();
    expect(await readFile(join(reserved.directory, 'task.txt'), 'utf8')).toBe(
      'preexisting retained data',
    );
    expect(f.service.getHostReservation(f.input)).toMatchObject({ state: 'claiming' });
    expect(copy.calls).not.toHaveBeenCalled();
  });
  it('refuses a preexisting symlink task container without modifying its target', async () => {
    const f = await fixture();
    await f.service.reserveHostTask(f.input);
    const retained = join(f.root, 'retained-data');
    await mkdir(retained);
    await writeFile(join(retained, 'keep.txt'), 'keep');
    await symlink(retained, join(f.taskRoot, `repo-${f.input.id}`));
    await expect(f.service.claimReservedHostTask(f.input)).rejects.toThrow();
    expect(await readFile(join(retained, 'keep.txt'), 'utf8')).toBe('keep');
    expect(copy.calls).not.toHaveBeenCalled();
  });
  it('validates claimed cold retries while preserving task edits and one copy', async () => {
    const f = await fixture();
    await f.service.reserveHostTask(f.input);
    const claimed = await f.service.claimReservedHostTask(f.input);
    await writeFile(join(claimed.directory!, 'task.txt'), 'retained edits');
    f.git(claimed.directory!, 'add', 'task.txt');
    f.git(claimed.directory!, 'commit', '-qm', 'legitimate task progress');
    f.service.close();
    services.delete(f.service);
    const cold = f.open();
    expect((await cold.claimReservedHostTask(f.input)).directory).toBe(claimed.directory);
    expect(await readFile(join(claimed.directory!, 'task.txt'), 'utf8')).toBe('retained edits');
    expect(copy.calls).toHaveBeenCalledTimes(1);
  });
  it('refuses revoked and canceled admission before task effects while retaining reservation', async () => {
    const f = await fixture();
    await f.service.reserveHostTask(f.input);
    f.authorize.mockRejectedValue(new Error('revoked'));
    await expect(f.service.claimReservedHostTask(f.input)).rejects.toThrow();
    expect(f.service.getHostReservation(f.input)).toMatchObject({ state: 'reserved' });
    f.authorize.mockResolvedValue({ revision: 1, allowedBaseBranches: ['main'] });
    const canceled = new AbortController();
    canceled.abort();
    await expect(
      f.service.claimReservedHostTask({ ...f.input, signal: canceled.signal }),
    ).rejects.toThrow();
    expect(copy.calls).not.toHaveBeenCalled();
  });
  it('does not reserve a canceled command or mutate its prepared record', async () => {
    const f = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      f.service.reserveHostTask({ ...f.input, signal: controller.signal }),
    ).rejects.toThrow();
    expect(f.service.status(f.input.id, binding)).toMatchObject({ state: 'ready' });
    expect(f.service.get(f.input.id)).not.toHaveProperty('conversationId');
    expect(copy.calls).not.toHaveBeenCalled();
  });
  it('retains claiming uncertainty if account access is revoked after copy begins', async () => {
    const f = await fixture();
    await f.service.reserveHostTask(f.input);
    copy.before = async () => {
      f.authorize.mockRejectedValue(new Error('revoked after effect'));
    };
    await expect(f.service.claimReservedHostTask(f.input)).rejects.toThrow();
    expect(f.service.getHostReservation(f.input)).toMatchObject({ state: 'claiming' });
    expect(copy.calls).toHaveBeenCalledTimes(1);
  });
  it('clones mutable input before asynchronous authorization', async () => {
    const f = await fixture();
    const gate = deferred();
    const entered = deferred();
    f.authorize.mockImplementationOnce(async () => {
      entered.release();
      await gate.promise;
      return { revision: 1, allowedBaseBranches: ['main'] };
    });
    const original = structuredClone({ ...f.input, signal: undefined });
    const pending = f.service.reserveHostTask(f.input);
    await entered.promise;
    f.input.binding.accountId = 'mutated-account';
    f.input.conversationId = 'mutated-conversation';
    f.input.taskRoot = '/mutated-root';
    gate.release();
    expect(await pending).toMatchObject({
      conversationId: original.conversationId,
      binding: original.binding,
      hostReservation: { taskRoot: original.taskRoot },
    });
    expect(copy.calls).not.toHaveBeenCalled();
  });
  it('clones materialization input before asynchronous authorization', async () => {
    const f = await fixture();
    await f.service.reserveHostTask(f.input);
    const gate = deferred();
    const entered = deferred();
    f.authorize.mockImplementationOnce(async () => {
      entered.release();
      await gate.promise;
      return { revision: 1, allowedBaseBranches: ['main'] };
    });
    const original = { ...f.input, binding: { ...f.input.binding } };
    const pending = f.service.claimReservedHostTask(f.input);
    await entered.promise;
    f.input.binding.model = 'changed-model';
    f.input.conversationId = 'changed-conversation';
    f.input.taskRoot = '/changed-task-root';
    gate.release();
    const claimed = await pending;
    expect(claimed).toMatchObject({
      binding: original.binding,
      conversationId: original.conversationId,
      directory: join(original.taskRoot, `repo-${original.id}`, 'mgmt'),
    });
    expect(f.service.getHostReservation(original)).toMatchObject({ state: 'claimed' });
    expect(copy.calls).toHaveBeenCalledTimes(1);
  });
  it('returned reservation mutation cannot rewrite its retained identity', async () => {
    const f = await fixture();
    const result = await f.service.reserveHostTask(f.input);
    result.binding.model = 'changed-model';
    result.hostReservation.taskRoot = '/changed-root';
    expect(f.service.getHostReservation(f.input)).toMatchObject({
      binding,
      hostReservation: { taskRoot: f.taskRoot },
      state: 'reserved',
    });
  });
  it('refuses replacement task roots and changed prepared sources without copying', async () => {
    const f = await fixture();
    await f.service.reserveHostTask(f.input);
    await rename(f.taskRoot, f.taskRoot + '-retained');
    await mkdir(f.taskRoot);
    await expect(f.service.claimReservedHostTask(f.input)).rejects.toThrow();
    expect(copy.calls).not.toHaveBeenCalled();
    const g = await fixture();
    await g.service.reserveHostTask(g.input);
    await writeFile(join(g.privateRoot, g.input.id, 'mgmt', 'task.txt'), 'changed seed');
    await expect(g.service.claimReservedHostTask(g.input)).rejects.toThrow();
    expect(copy.calls).not.toHaveBeenCalled();
  });
  it.each(['directory', 'marker-version', 'root-identity', 'source-digest', 'base-oid'] as const)(
    'fails closed on corrupt persisted %s and preserves its row',
    async (field) => {
      const f = await fixture();
      await f.service.reserveHostTask(f.input);
      const db = new Database(join(f.privateRoot, 'workspaces.db'));
      try {
        const row = db
          .prepare('SELECT record FROM repository_workspaces WHERE id=?')
          .get(f.input.id) as { record: string };
        const damaged = JSON.parse(row.record) as Record<string, unknown>;
        const marker = damaged.hostReservation as {
          version: number;
          taskRoot: string;
          rootIdentity: { dev: number; ino: number };
        };
        if (field === 'directory') damaged.directory = join(f.root, 'other-destination');
        if (field === 'marker-version') damaged.hostReservation = { ...marker, version: 999 };
        if (field === 'root-identity')
          damaged.hostReservation = { ...marker, rootIdentity: { dev: 'wrong', ino: 1 } };
        if (field === 'source-digest') damaged.sourceDigest = 'wrong';
        if (field === 'base-oid') damaged.baseOid = 'wrong';
        db.prepare('UPDATE repository_workspaces SET record=? WHERE id=?').run(
          JSON.stringify(damaged),
          f.input.id,
        );
        expect(() => f.service.getHostReservation(f.input)).toThrow();
        await expect(f.service.claimReservedHostTask(f.input)).rejects.toThrow();
        expect(copy.calls).not.toHaveBeenCalled();
        expect(
          (
            db.prepare('SELECT record FROM repository_workspaces WHERE id=?').get(f.input.id) as {
              record: string;
            }
          ).record,
        ).toBe(JSON.stringify(damaged));
      } finally {
        db.close();
      }
    },
  );
  it.each(['claim', 'discard'] as const)(
    'refuses a stale legacy %s snapshot after a second store reserves ownership',
    async (operation) => {
      const f = await fixture();
      const second = f.open();
      const staleReady = structuredClone(f.service.get(f.input.id));
      const pinned = await second.reserveHostTask(f.input);
      const reservedRecord = structuredClone(second.get(f.input.id));
      const read = f.service.get.bind(f.service);
      vi.spyOn(f.service, 'get').mockImplementation((id) =>
        id === f.input.id ? structuredClone(staleReady) : read(id),
      );
      const source = join(f.privateRoot, f.input.id, 'mgmt', 'task.txt');
      const before = await readFile(source, 'utf8');
      const outcome = await (
        operation === 'claim'
          ? f.service.claim(f.input.id, binding, 'stale-legacy-owner', f.taskRoot, false)
          : f.service.discard(f.input.id, binding)
      ).then(
        () => ({ status: 'accepted' }),
        (error: unknown) => ({ status: 'rejected', error }),
      );
      const sourceAfter = await readFile(source, 'utf8').catch(() => undefined);
      expect({
        outcome: outcome.status,
        record: second.get(f.input.id),
        source: sourceAfter,
        copies: copy.calls.mock.calls.length,
      }).toMatchObject({
        outcome: 'rejected',
        record: {
          state: 'reserved',
          conversationId: pinned.conversationId,
          hostReservation: pinned.hostReservation,
        },
        source: before,
        copies: 0,
      });
      expect(second.getHostReservation(f.input)).toEqual(pinned);
      expect(second.get(f.input.id)).toEqual(reservedRecord);
    },
  );

  it('omits released seed on a claimed cold retry while preserving the physical task', async () => {
    const f = await fixture();
    await f.service.reserveHostTask(f.input);
    const claimed = await f.service.claimReservedHostTask(f.input);
    await writeFile(join(claimed.directory!, 'task.txt'), 'retained task');
    await f.service.releaseSource(f.input.id, binding, f.input.conversationId);
    f.service.close();
    services.delete(f.service);
    const cold = f.open();
    const resumed = await cold.claimReservedHostTask(f.input);
    expect(resumed).not.toHaveProperty('seed');
    expect(await readFile(join(claimed.directory!, 'task.txt'), 'utf8')).toBe('retained task');
    expect(copy.calls).toHaveBeenCalledTimes(1);
  });
  it.each(['json-id', 'sql-conversation', 'path-id'] as const)(
    'rejects new ready %s corruption before authority callbacks or source reads',
    async (field) => {
      const f = await fixture();
      const db = new Database(join(f.privateRoot, 'workspaces.db'));
      try {
        const row = db
          .prepare('SELECT record FROM repository_workspaces WHERE id=?')
          .get(f.input.id) as { record: string };
        const record = JSON.parse(row.record) as Record<string, unknown>;
        if (field === 'json-id') {
          record.id = 'other-workspace';
          db.prepare('UPDATE repository_workspaces SET record=? WHERE id=?').run(
            JSON.stringify(record),
            f.input.id,
          );
        }
        if (field === 'sql-conversation')
          db.prepare('UPDATE repository_workspaces SET conversation_id=? WHERE id=?').run(
            'preexisting-owner',
            f.input.id,
          );
        if (field === 'path-id') {
          const pathId = '../../escape';
          record.id = pathId;
          record.featureBranch = `mitzo/repo-${pathId}`;
          db.prepare('UPDATE repository_workspaces SET id=?,record=? WHERE id=?').run(
            pathId,
            JSON.stringify(record),
            f.input.id,
          );
          f.input.id = pathId;
        }
        f.authorize.mockClear();
        f.verify.mockClear();
        sourceReads.mockClear();
        await expect(f.service.reserveHostTask(f.input)).rejects.toThrow();
        expect({
          authority: f.authorize.mock.calls.length,
          verification: f.verify.mock.calls.length,
          sourceReads: sourceReads.mock.calls.length,
          copies: copy.calls.mock.calls.length,
        }).toEqual({ authority: 0, verification: 0, sourceReads: 0, copies: 0 });
      } finally {
        db.close();
      }
    },
  );
  it('preserves compatibility with an accepted Git branch longer than an account reference', async () => {
    const f = await fixture();
    const branch = `feature/${'a'.repeat(220)}`;
    f.git(f.source, 'branch', branch);
    f.inspect.mockResolvedValue({
      repository: 'example/repo',
      baseBranch: branch,
      baseOid: f.git(f.source, 'rev-parse', 'HEAD'),
    });
    f.authorize.mockResolvedValue({ revision: 1, allowedBaseBranches: [branch] });
    const ready = await f.ready();
    const result = await f.service.reserveHostTask({ ...f.input, id: ready.id });
    expect(result.baseBranch).toBe(branch);
    expect(copy.calls).not.toHaveBeenCalled();
  });

  it('a stale competing preparation cannot overwrite or remove the winner reserved source', async () => {
    const f = await fixture();
    const second = f.open();
    const gate = deferred();
    const entered = deferred();
    const preview = await f.service.preview(binding, 'connection', 'example/repo', f.input.signal);
    const stalePreview = structuredClone(f.service.get(preview.id));
    const read = f.service.get.bind(f.service);
    vi.spyOn(f.service, 'get').mockImplementation((id) =>
      id === preview.id ? structuredClone(stalePreview) : read(id),
    );
    f.authorize.mockImplementationOnce(async () => {
      entered.release();
      await gate.promise;
      return { revision: 1, allowedBaseBranches: ['main'] };
    });
    const loser = f.service.prepare(preview.id, binding, f.input.signal).then(
      () => ({ status: 'accepted' }),
      (error: unknown) => ({ status: 'rejected', error }),
    );
    await entered.promise;
    await second.prepare(preview.id, binding, f.input.signal);
    const winnerInput = { ...f.input, id: preview.id };
    await second.reserveHostTask(winnerInput);
    const pinned = structuredClone(second.get(preview.id));
    gate.release();
    const outcome = await loser;
    const source = await readFile(
      join(f.privateRoot, preview.id, 'mgmt', 'task.txt'),
      'utf8',
    ).catch(() => undefined);
    expect({
      outcome: outcome.status,
      source,
      copies: copy.calls.mock.calls.length,
      row: second.get(preview.id),
    }).toEqual({ outcome: 'rejected', source: 'accepted source', copies: 0, row: pinned });
  });
  it('a delayed chat handoff cannot rewrite a concurrently prepared and reserved row', async () => {
    const f = await fixture();
    const second = f.open();
    const gate = deferred();
    const entered = deferred();
    const preview = f.service.preview.bind(f.service);
    let acquiredId = '';
    vi.spyOn(f.service, 'preview').mockImplementationOnce(async (...args) => {
      const acquired = await preview(...args);
      acquiredId = acquired.id;
      entered.release();
      await gate.promise;
      return acquired;
    });
    const losing = f.service
      .prepareChat(
        binding,
        'source-chat',
        'connection',
        'example/repo',
        'delayed handoff',
        f.input.signal,
      )
      .then(
        () => ({ status: 'accepted' }),
        (error: unknown) => ({ status: 'rejected', error }),
      );
    await entered.promise;
    await second.prepare(acquiredId, binding, f.input.signal);
    const winnerInput = { ...f.input, id: acquiredId };
    await second.reserveHostTask(winnerInput);
    const pinned = structuredClone(second.get(acquiredId));
    gate.release();
    const outcome = await losing;
    expect({ outcome: outcome.status, row: second.get(acquiredId) }).toEqual({
      outcome: 'rejected',
      row: pinned,
    });
    expect(await readFile(join(f.privateRoot, acquiredId, 'mgmt', 'task.txt'), 'utf8')).toBe(
      'accepted source',
    );
    expect(copy.calls).not.toHaveBeenCalled();
  });

  it.each(['retained', 'released'] as const)(
    'legacy claim cannot adopt a settled new-marker task with %s source',
    async (sourceState) => {
      const f = await fixture();
      await f.service.reserveHostTask(f.input);
      const task = await f.service.claimReservedHostTask(f.input);
      await writeFile(join(task.directory!, 'task.txt'), 'retained edits');
      if (sourceState === 'released')
        await f.service.releaseSource(f.input.id, binding, f.input.conversationId);
      const pinned = structuredClone(f.service.get(f.input.id));
      const sourcePath = join(f.privateRoot, f.input.id, 'mgmt', 'task.txt');
      const source = await readFile(sourcePath, 'utf8').catch(() => undefined);
      const outcome = await f.service
        .claim(f.input.id, binding, f.input.conversationId, f.taskRoot, false)
        .then(
          () => 'accepted',
          () => 'rejected',
        );
      expect({
        outcome,
        row: f.service.get(f.input.id),
        task: await readFile(join(task.directory!, 'task.txt'), 'utf8'),
        source: await readFile(sourcePath, 'utf8').catch(() => undefined),
        copies: copy.calls.mock.calls.length,
      }).toEqual({ outcome: 'rejected', row: pinned, task: 'retained edits', source, copies: 1 });
    },
  );

  it.each(['content', 'head'] as const)(
    'refuses initial %s drift in the final authority callback and retains uncertainty',
    async (drift) => {
      const f = await fixture();
      const reserved = await f.service.reserveHostTask(f.input);
      copy.before = async () => {
        f.authorize.mockImplementationOnce(async () => {
          if (drift === 'content')
            await writeFile(join(reserved.directory, 'task.txt'), 'unadmitted callback content');
          else f.git(reserved.directory, 'checkout', '-q', '--detach', 'HEAD');
          return { revision: 1, allowedBaseBranches: ['main'] };
        });
      };
      const outcome = await f.service.claimReservedHostTask(f.input).then(
        () => 'accepted',
        () => 'rejected',
      );
      expect({
        outcome,
        state: f.service.getHostReservation(f.input).state,
        copies: copy.calls.mock.calls.length,
      }).toEqual({ outcome: 'rejected', state: 'claiming', copies: 1 });
      await expect(f.service.claimReservedHostTask(f.input)).rejects.toThrow();
      expect(await readFile(join(f.privateRoot, f.input.id, 'mgmt', 'task.txt'), 'utf8')).toBe(
        'accepted source',
      );
    },
  );
  it('refuses retained checkout replacement in the final authority callback without replay or cleanup', async () => {
    const f = await fixture();
    await f.service.reserveHostTask(f.input);
    const task = await f.service.claimReservedHostTask(f.input);
    await writeFile(join(task.directory!, 'task.txt'), 'retained edits');
    const originalGit = join(task.directory!, '.git');
    const retainedGit = originalGit + '-retained';
    f.authorize
      .mockResolvedValueOnce({ revision: 1, allowedBaseBranches: ['main'] })
      .mockImplementationOnce(async () => {
        await rename(originalGit, retainedGit);
        await cp(retainedGit, originalGit, { recursive: true });
        return { revision: 1, allowedBaseBranches: ['main'] };
      });
    const pinned = structuredClone(f.service.get(f.input.id));
    await expect(f.service.claimReservedHostTask(f.input)).rejects.toThrow();
    expect(f.service.get(f.input.id)).toEqual(pinned);
    expect(await readFile(join(task.directory!, 'task.txt'), 'utf8')).toBe('retained edits');
    await expect(access(retainedGit)).resolves.toBeUndefined();
    expect(copy.calls).toHaveBeenCalledTimes(1);
  });

  it('includes reserved sources in the existing eight-preparation account budget', async () => {
    const f = await fixture();
    await f.service.reserveHostTask(f.input);
    for (let index = 1; index < 8; index++) {
      const ready = await f.ready();
      await f.service.reserveHostTask({
        ...f.input,
        id: ready.id,
        conversationId: `conversation-${index + 1}`,
      });
    }
    await expect(f.ready()).rejects.toThrow(/eight/);
    expect(copy.calls).not.toHaveBeenCalled();
  });
  it('does not replace or discard a reserved handoff when another task is requested', async () => {
    const f = await fixture();
    const handoff = await f.service.prepareChat(
      binding,
      'source-chat',
      'connection',
      'example/repo',
      'first task',
      f.input.signal,
    );
    const input = { ...f.input, id: handoff.id };
    const reserved = await f.service.reserveHostTask(input);
    await expect(
      f.service.prepareChat(
        binding,
        'source-chat',
        'connection',
        'example/repo',
        'changed task',
        f.input.signal,
      ),
    ).rejects.toThrow(/running or interrupted/);
    expect(f.service.getHostReservation(input)).toEqual(reserved);
    expect(copy.calls).not.toHaveBeenCalled();
  });
  it('leaves the existing host and sandbox claim APIs compatible for unreserved records', async () => {
    const f = await fixture();
    const host = await f.service.claim(f.input.id, binding, 'legacy-host', f.taskRoot, false);
    expect(host.state).toBe('claimed');
    const legacyInput = { ...f.input, conversationId: 'legacy-host' };
    expect(() => f.service.getHostReservation(legacyInput)).toThrow();
    await expect(f.service.reserveHostTask(legacyInput)).rejects.toThrow();
    await expect(f.service.claimReservedHostTask(legacyInput)).rejects.toThrow();
    const ready = await f.ready();
    const sandbox = await f.service.claim(ready.id, binding, 'legacy-sandbox', f.taskRoot, true);
    expect(sandbox).toMatchObject({ state: 'claimed', sandbox: true });
    expect(sandbox.directory).toBeUndefined();
    expect(copy.calls).toHaveBeenCalledTimes(1);
  });
});
