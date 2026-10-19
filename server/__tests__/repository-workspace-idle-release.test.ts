import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RepositoryWorkspaces } from '../repository-workspaces.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const binding = {
  accountId: 'offline',
  accountLabel: 'Offline fixture',
  provider: 'openai-codex' as const,
  model: 'fixture',
  profileRevision: 'r1',
};
const runtime = {
  version: 2 as const,
  account: {
    accountId: binding.accountId,
    provider: binding.provider,
    profileRevision: binding.profileRevision,
  },
  harness: { implementation: 'codex' as const },
  execution: { location: 'local' as const, targetId: 'mac', targetRevision: 't1' },
};
const signal = () => new AbortController().signal;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'repository-idle-owner-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'private');
  const authorize = vi.fn(async () => ({ revision: 1, allowedBaseBranches: ['main'] }));
  const inspect = vi.fn(async () => ({
    repository: 'example/repo',
    baseBranch: 'main',
    baseOid: 'a'.repeat(40),
  }));
  const prepare = vi.fn(async (preview, path: string, featureBranch: string) => {
    await mkdir(join(path, '.git'), { recursive: true });
    await writeFile(join(path, '.git', 'HEAD'), `ref: refs/heads/${featureBranch}\n`);
    await writeFile(join(path, 'source.txt'), 'Retain these exact source bytes.');
    return { ...preview, directory: path, featureBranch };
  });
  const assert = vi.fn(async () => {});
  const service = new RepositoryWorkspaces(directory, {
    authorize,
    inspect,
    prepare,
    ordinaryPreparation: {
      capture: async () => ({
        version: 1,
        originalBinding: binding,
        runtimeBinding: runtime,
        credentialDigest: 'b'.repeat(64),
      }),
      assert,
    },
  });
  const close = vi.spyOn(service, 'close');
  cleanups.push(() => {
    if (!close.mock.calls.length) service.close();
  });
  const preview = () =>
    service.preview(binding, 'connection', 'example/repo', signal(), {
      runOn: 'local',
      runtime: { account: runtime.account, harness: 'codex', targetId: 'mac' },
    });
  return { root, directory, service, authorize, inspect, prepare, assert, close, preview };
}

describe('existing repository workspace idle release', () => {
  it('refuses a suspended preview without closing or replacing its original operation', async () => {
    const f = await fixture();
    const gate = deferred<{ revision: number; allowedBaseBranches: string[] }>();
    f.authorize.mockImplementationOnce(() => gate.promise);
    const operation = f.preview();
    try {
      expect(() => f.service.closeIdle()).toThrow('active');
      expect(f.close).not.toHaveBeenCalled();
      expect(f.inspect).not.toHaveBeenCalled();
      gate.resolve({ revision: 1, allowedBaseBranches: ['main'] });
      expect((await operation).state).toBe('preview');
      f.service.closeIdle();
      expect(f.close).toHaveBeenCalledOnce();
    } finally {
      gate.resolve({ revision: 1, allowedBaseBranches: ['main'] });
      await operation.catch(() => undefined);
    }
  });

  it('refuses a suspended prepare without deleting source or changing its preparing receipt', async () => {
    const f = await fixture();
    const preview = await f.preview();
    const entered = deferred<void>(),
      gate = deferred<void>();
    const original = f.prepare.getMockImplementation()!;
    f.prepare.mockImplementationOnce(async (...args) => {
      entered.resolve();
      await gate.promise;
      return original(...args);
    });
    const operation = f.service.prepare(preview.id, binding, signal());
    await entered.promise;
    try {
      const before = f.service.get(preview.id);
      expect(before.state).toBe('preparing');
      expect(() => f.service.closeIdle()).toThrow('active');
      expect(f.close).not.toHaveBeenCalled();
      expect(f.service.get(preview.id)).toEqual(before);
      expect(existsSync(join(f.directory, preview.id))).toBe(true);
      gate.resolve();
      expect((await operation).state).toBe('ready');
      f.service.closeIdle();
    } finally {
      gate.resolve();
      await operation.catch(() => undefined);
    }
  });

  it('refuses suspended ordinary requalification without cancelling it or adopting a new row', async () => {
    const f = await fixture();
    const preview = await f.preview();
    await f.service.prepare(preview.id, binding, signal());
    const gate = deferred<void>();
    f.assert.mockImplementationOnce(() => gate.promise);
    const operation = f.service.qualifiedStatus(preview.id, binding);
    try {
      const before = f.service.get(preview.id);
      expect(() => f.service.closeIdle()).toThrow('active');
      expect(f.close).not.toHaveBeenCalled();
      expect(f.service.get(preview.id)).toEqual(before);
      gate.resolve();
      expect((await operation).state).toBe('ready');
      f.service.closeIdle();
    } finally {
      gate.resolve();
      await operation.catch(() => undefined);
    }
  });

  it('retains the exact pending chat promise and refuses release across nested preview/prepare operations', async () => {
    const f = await fixture();
    const entered = deferred<void>(),
      gate = deferred<void>();
    const original = f.prepare.getMockImplementation()!;
    f.prepare.mockImplementationOnce(async (...args) => {
      entered.resolve();
      await gate.promise;
      return original(...args);
    });
    const first = f.service.prepareChat(
      binding,
      'source-chat',
      'connection',
      'example/repo',
      'Original task',
      signal(),
    );
    const second = f.service.prepareChat(
      binding,
      'source-chat',
      'connection',
      'example/repo',
      'Original task',
      signal(),
    );
    try {
      expect(second).toBe(first);
      expect(() => f.service.closeIdle()).toThrow('active');
      await entered.promise;
      expect(() => f.service.closeIdle()).toThrow('active');
      gate.resolve();
      const receipt = await first;
      expect(await second).toEqual(receipt);
      expect(f.service.chatPreparation(receipt.id, binding, 'source-chat')).toEqual(receipt);
      expect(f.prepare).toHaveBeenCalledOnce();
      f.service.closeIdle();
    } finally {
      gate.resolve();
      await first.catch(() => undefined);
    }
  });

  it('preserves READY source bytes and durable history, releases once, and fences every later operation', async () => {
    const f = await fixture();
    const preview = await f.preview();
    await f.service.prepare(preview.id, binding, signal());
    const ready = f.service.get(preview.id);
    const path = join(f.directory, preview.id, 'mgmt', 'source.txt');
    const before = await readFile(path);
    const reader = new Database(join(f.directory, 'workspaces.db'), { readonly: true });
    try {
      const rows = () => reader.prepare('SELECT * FROM repository_workspaces ORDER BY id').all();
      const history = rows();
      f.service.closeIdle();
      f.service.closeIdle();
      expect(f.close).toHaveBeenCalledOnce();
      expect(rows()).toEqual(history);
      expect(JSON.parse((history[0] as { record: string }).record)).toEqual(ready);
      expect(await readFile(path)).toEqual(before);
      expect(() => f.service.get(preview.id)).toThrow('released');
      expect(() => f.service.getForConversation('source-chat')).toThrow('released');
      expect(() => f.service.status(preview.id, binding)).toThrow('released');
      expect(() => f.service.chatPreparation(undefined, binding, 'source-chat')).toThrow(
        'released',
      );
      expect(() => f.service.getHostReservation(undefined as never)).toThrow('released');
      expect(() =>
        f.service.prepareChat(
          binding,
          'source-chat',
          'connection',
          'example/repo',
          'Task',
          signal(),
        ),
      ).toThrow('released');
      await expect(f.preview()).rejects.toThrow('released');
      await expect(f.service.prepare(preview.id, binding, signal())).rejects.toThrow('released');
      await expect(f.service.qualifiedStatus(preview.id, binding)).rejects.toThrow('released');
      await expect(f.service.discard(preview.id, binding)).rejects.toThrow('released');
      await expect(f.service.releaseSource(preview.id, binding, 'chat')).rejects.toThrow(
        'released',
      );
      await expect(f.service.startupSeed(preview.id, binding, 'chat', signal())).rejects.toThrow(
        'released',
      );
      await expect(f.service.validateHostTask('chat', '/workspace')).rejects.toThrow('released');
      await expect(
        f.service.prepareOrdinarySession(undefined as never, undefined as never),
      ).rejects.toThrow('released');
      await expect(f.service.reserveHostTask(undefined as never)).rejects.toThrow('released');
      await expect(f.service.reserveOrdinarySandboxTask(undefined as never)).rejects.toThrow(
        'released',
      );
      await expect(f.service.claimReservedHostTask(undefined as never)).rejects.toThrow('released');
      await expect(
        f.service.claim(preview.id, binding, 'chat', '/workspace', false),
      ).rejects.toThrow('released');
      expect(rows()).toEqual(history);
      expect(await readFile(path)).toEqual(before);
    } finally {
      reader.close();
    }
  });

  it('releases rejected operations so an idle owner can subsequently close', async () => {
    const f = await fixture();
    f.authorize.mockRejectedValueOnce(Error('Offline authorization refused'));
    await expect(f.preview()).rejects.toThrow('Offline authorization refused');
    f.service.closeIdle();
    expect(f.close).toHaveBeenCalledOnce();
  });
});

it('releases only the already-created singleton and refuses recreation under another private path', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'repository-idle-singleton-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', root);
  vi.stubEnv('MITZO_INTERNAL_TOKEN_PATH', join(root, 'internal-token'));
  vi.stubEnv('MITZO_REPOSITORY_WORKSPACES_ENABLED', '1');
  const owner = await import('../repository-workspace-runtime.js');
  owner.closeIdleRepositoryWorkspaces();
  expect(existsSync(join(root, 'repository-sources'))).toBe(false);
  const service = owner.getRepositoryWorkspaces();
  const close = vi.spyOn(service, 'close');
  cleanups.push(() => {
    if (!close.mock.calls.length) service.close();
  });
  const pending = service.prepare('missing', binding, signal());
  expect(() => owner.closeIdleRepositoryWorkspaces()).toThrow('active');
  expect(owner.getRepositoryWorkspaces()).toBe(service);
  await expect(pending).rejects.toThrow('unavailable');
  owner.closeIdleRepositoryWorkspaces();
  owner.closeIdleRepositoryWorkspaces();
  expect(close).toHaveBeenCalledOnce();
  const other = join(root, 'another-private-path');
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', other);
  expect(() => owner.getRepositoryWorkspaces()).toThrow('released');
  expect(() => owner.getRepositoryWorkspaces(true)).toThrow('released');
  expect(existsSync(other)).toBe(false);
});
