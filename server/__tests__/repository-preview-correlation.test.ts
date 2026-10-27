import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, mkdir, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountBindingSchema } from '@mitzo/protocol';
import type { AccountBinding } from '@mitzo/protocol';
import { RepositoryWorkspaces } from '../repository-workspaces.js';
import type {
  OrdinaryRepositoryRuntimeSelection,
  OrdinaryRepositoryPreparation,
} from '../ordinary-repository-preparation.js';

const binding = AccountBindingSchema.parse({
  accountId: 'offline',
  accountLabel: 'Offline',
  provider: 'openai-codex',
  model: 'offline-fixture',
  profileRevision: 'r1',
});
const runtime: OrdinaryRepositoryRuntimeSelection = {
  runOn: 'openshell',
  runtime: {
    account: { accountId: binding.accountId, provider: binding.provider, profileRevision: 'r1' },
    harness: 'codex',
    targetId: 'target',
  },
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'preview-correlation-')));
  const services: RepositoryWorkspaces[] = [];
  cleanups.push(async () => {
    services.forEach((service) => service.close());
    await rm(root, { recursive: true, force: true });
  });
  const authorize = vi.fn(async () => ({ revision: 1, allowedBaseBranches: ['main'] }));
  const inspect = vi.fn(async (repository: string) => ({
    repository,
    baseBranch: 'main',
    baseOid: 'a'.repeat(40),
  }));
  const capture = vi.fn(
    async (selected: AccountBinding, selection: OrdinaryRepositoryRuntimeSelection) => ({
      version: 1 as const,
      originalBinding: AccountBindingSchema.parse(selected),
      runtimeBinding: {
        version: 2 as const,
        account: selection.runtime.account,
        harness: { implementation: selection.runtime.harness },
        execution: {
          location: selection.runOn,
          targetId: selection.runtime.targetId,
          targetRevision: 'r1',
        },
      },
      credentialDigest: 'a'.repeat(64),
    }),
  );
  const assert = vi.fn(async (_proof: OrdinaryRepositoryPreparation) => {});
  const prepare = vi.fn<
    typeof import('../github-repository-source.js').prepareGithubRepositorySource
  >(async () => {
    throw Error('Preview must not acquire source');
  });
  const open = () => {
    const service = new RepositoryWorkspaces(join(root, 'private'), {
      authorize,
      inspect,
      prepare,
      ordinaryPreparation: { capture, assert },
    });
    services.push(service);
    return service;
  };
  const rows = () => {
    const db = new Database(join(root, 'private', 'workspaces.db'));
    try {
      return db.prepare('SELECT record FROM repository_workspaces ORDER BY id').all() as Array<{
        record: string;
      }>;
    } finally {
      db.close();
    }
  };
  return { root, open, service: open(), authorize, inspect, capture, assert, prepare, rows };
}
const signal = () => new AbortController().signal;
it('recovers the original known preview across owners without reinspection or source acquisition', async () => {
  const f = await fixture();
  const id = randomUUID();
  const first = await f.service.preview(
    binding,
    'connection',
    'Example/Repo',
    signal(),
    runtime,
    id,
  );
  expect(first).toMatchObject({
    id,
    repository: 'example/repo',
    baseOid: 'a'.repeat(40),
    state: 'preview',
  });
  f.inspect.mockResolvedValue({
    repository: 'example/repo',
    baseBranch: 'main',
    baseOid: 'b'.repeat(40),
  });
  expect(
    await f
      .open()
      .preview(binding, 'connection', 'https://github.com/example/repo.git', signal(), runtime, id),
  ).toEqual(first);
  expect(f.inspect).toHaveBeenCalledOnce();
  expect(f.capture).toHaveBeenCalledOnce();
  expect(f.assert).toHaveBeenCalled();
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.rows()).toHaveLength(1);
  expect(first).not.toHaveProperty('previewIntentFingerprint');
  expect(first).not.toHaveProperty('ordinaryPreparation');
});
it('refuses changed account, model, connection, repository or runtime under an original ID', async () => {
  const f = await fixture();
  const id = randomUUID();
  await f.service.preview(binding, 'connection', 'example/repo', signal(), runtime, id);
  const before = f.rows();
  for (const change of [
    { binding: { ...binding, accountId: 'other' } },
    { binding: { ...binding, model: 'other' } },
    { binding: { ...binding, profileRevision: 'r2' } },
    { connection: 'other' },
    { repository: 'example/other' },
    { runtime: { ...runtime, runOn: 'local' as const } },
    { runtime: { ...runtime, runtime: { ...runtime.runtime, targetId: 'other' } } },
    { runtime: undefined },
  ]) {
    await expect(
      f.service.preview(
        change.binding ?? binding,
        change.connection ?? 'connection',
        change.repository ?? 'example/repo',
        signal(),
        'runtime' in change ? change.runtime : runtime,
        id,
      ),
    ).rejects.toThrow(/identity|selection|conflict/i);
  }
  expect(f.rows()).toEqual(before);
  expect(f.inspect).toHaveBeenCalledOnce();
  expect(f.capture).toHaveBeenCalledOnce();
});
it('returns the first committed same-intent pin across racing independent owners', async () => {
  const f = await fixture();
  const second = f.open();
  const id = randomUUID();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.inspect.mockImplementationOnce(async (repository) => {
    entered();
    await gate;
    return { repository, baseBranch: 'main', baseOid: 'a'.repeat(40) };
  });
  const delayed = f.service.preview(binding, 'connection', 'example/repo', signal(), runtime, id);
  await started;
  f.inspect.mockResolvedValue({
    repository: 'example/repo',
    baseBranch: 'main',
    baseOid: 'b'.repeat(40),
  });
  const winner = await second.preview(binding, 'connection', 'example/repo', signal(), runtime, id);
  release();
  expect(await delayed).toEqual(winner);
  expect(winner.baseOid).toBe('b'.repeat(40));
  expect(f.rows()).toHaveLength(1);
});
it('does not overwrite a different intent that wins while metadata capture is in flight', async () => {
  const f = await fixture();
  const second = f.open();
  const id = randomUUID();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.inspect.mockImplementationOnce(async (repository) => {
    entered();
    await gate;
    return { repository, baseBranch: 'main', baseOid: 'a'.repeat(40) };
  });
  const delayed = f.service.preview(binding, 'connection', 'example/repo', signal(), runtime, id);
  await started;
  const winner = await second.preview(
    binding,
    'connection',
    'example/other',
    signal(),
    runtime,
    id,
  );
  const before = f.rows();
  release();
  await expect(delayed).rejects.toThrow(/identity|selection|conflict/i);
  expect(winner.repository).toBe('example/other');
  expect(f.rows()).toEqual(before);
});
it('retains a discarded original and never recreates a preview on retry', async () => {
  const f = await fixture();
  const id = randomUUID();
  await f.service.preview(binding, 'connection', 'example/repo', signal(), undefined, id);
  await f.service.discard(id, binding);
  const before = f.rows();
  expect(
    await f.service.preview(binding, 'connection', 'example/repo', signal(), undefined, id),
  ).toMatchObject({ id, state: 'discarded' });
  expect(f.rows()).toEqual(before);
  expect(f.inspect).toHaveBeenCalledOnce();
  expect(f.prepare).not.toHaveBeenCalled();
});
it('renews actual connection and ordinary preparation authorization without changing the retained record', async () => {
  const f = await fixture();
  const id = randomUUID();
  await f.service.preview(binding, 'connection', 'example/repo', signal(), runtime, id);
  const before = f.rows();
  f.authorize.mockResolvedValue({ revision: 2, allowedBaseBranches: ['main'] });
  await expect(
    f.service.preview(binding, 'connection', 'example/repo', signal(), runtime, id),
  ).rejects.toThrow();
  f.authorize.mockResolvedValue({ revision: 1, allowedBaseBranches: ['main'] });
  f.assert.mockRejectedValue(Error('Runtime changed'));
  await expect(
    f.service.preview(binding, 'connection', 'example/repo', signal(), runtime, id),
  ).rejects.toThrow('Runtime changed');
  expect(f.rows()).toEqual(before);
  expect(f.inspect).toHaveBeenCalledOnce();
});
it('rejects invalid request identity before metadata effects and preserves legacy random-ID callers', async () => {
  const f = await fixture();
  await expect(
    f.service.preview(binding, 'connection', 'example/repo', signal(), undefined, '../bad'),
  ).rejects.toThrow();
  expect(f.authorize).not.toHaveBeenCalled();
  expect(f.inspect).not.toHaveBeenCalled();
  expect(f.rows()).toEqual([]);
  const legacy = await f.service.preview(binding, 'connection', 'example/repo', signal());
  expect(legacy.id).toMatch(/^[a-f0-9-]{36}$/);
});

async function ordinaryPreview(f: Awaited<ReturnType<typeof fixture>>) {
  // Acquisition/authentication are synthetic dependencies; actual owner state,
  // source identity, filesystem cleanup and SQLite receipts execute normally.
  f.prepare.mockImplementation(async (preview, directory, featureBranch) => {
    await mkdir(join(directory, '.git'), { recursive: true });
    await writeFile(join(directory, '.git', 'HEAD'), `ref: refs/heads/${featureBranch}\n`);
    await writeFile(join(directory, 'file.txt'), 'offline prepared source');
    return { ...preview, directory, featureBranch };
  });
  const id = randomUUID();
  await f.service.preview(binding, 'connection', 'example/repo', signal(), runtime, id);
  return { id, directory: join(f.root, 'private', id, 'mgmt') };
}
it('recovers terminal ordinary metadata after actual prepare then discard without reacquisition', async () => {
  const f = await fixture();
  const original = await ordinaryPreview(f);
  expect(await f.service.prepare(original.id, binding, signal())).toMatchObject({
    id: original.id,
    state: 'ready',
  });
  expect(f.service.get(original.id).ordinaryPreparation?.sourceIdentity).toBeDefined();
  expect(existsSync(original.directory)).toBe(true);
  await f.service.discard(original.id, binding);
  expect(existsSync(original.directory)).toBe(false);
  expect(f.service.get(original.id).retirement).toMatchObject({
    kind: 'unused',
    disposition: 'retired',
    receipt: { state: 'retired' },
  });
  const before = f.rows(),
    inspected = f.inspect.mock.calls.length,
    captured = f.capture.mock.calls.length;
  expect(
    await f.open().preview(binding, 'connection', 'example/repo', signal(), runtime, original.id),
  ).toMatchObject({ id: original.id, state: 'discarded' });
  expect(await f.service.qualifiedStatus(original.id, binding)).toMatchObject({
    id: original.id,
    state: 'discarded',
  });
  await expect(f.service.prepare(original.id, binding, signal())).rejects.toThrow('retiring');
  expect(f.rows()).toEqual(before);
  expect(f.prepare).toHaveBeenCalledOnce();
  expect(f.inspect).toHaveBeenCalledTimes(inspected);
  expect(f.capture).toHaveBeenCalledTimes(captured);
  f.authorize.mockResolvedValue({ revision: 2, allowedBaseBranches: ['main'] });
  await expect(
    f.service.preview(binding, 'connection', 'example/repo', signal(), runtime, original.id),
  ).rejects.toThrow();
  expect(f.rows()).toEqual(before);
  f.authorize.mockResolvedValue({ revision: 1, allowedBaseBranches: ['main'] });
  f.assert.mockRejectedValue(Error('Runtime authorization revoked'));
  await expect(
    f.service.preview(binding, 'connection', 'example/repo', signal(), runtime, original.id),
  ).rejects.toThrow('Runtime authorization revoked');
  expect(f.rows()).toEqual(before);
});
it('recovers the failed original after post-capture refusal and actual owned cleanup', async () => {
  const f = await fixture();
  const original = await ordinaryPreview(f);
  let refuse = true;
  f.assert.mockImplementation(async (proof) => {
    if (refuse && proof.sourceIdentity) throw Error('forced post-capture refusal');
  });
  await expect(f.service.prepare(original.id, binding, signal())).rejects.toThrow(
    'forced post-capture refusal',
  );
  expect(f.service.get(original.id)).toMatchObject({
    state: 'failed',
    ordinaryPreparation: { sourceIdentity: expect.any(Object) },
  });
  expect(existsSync(original.directory)).toBe(false);
  refuse = false;
  const before = f.rows();
  const recovered = await f.service.preview(
    binding,
    'connection',
    'example/repo',
    signal(),
    runtime,
    original.id,
  );
  expect(recovered).toMatchObject({ id: original.id, state: 'failed' });
  expect(recovered).not.toHaveProperty('ordinaryRuntime');
  expect(await f.open().qualifiedStatus(original.id, binding)).toMatchObject({
    id: original.id,
    state: 'failed',
  });
  expect(f.rows()).toEqual(before);
  expect(f.prepare).toHaveBeenCalledOnce();
});
it.each(['missing', 'replaced'] as const)(
  'still refuses unexplained %s source custody on a ready ordinary workspace',
  async (fault) => {
    const f = await fixture();
    const original = await ordinaryPreview(f);
    await f.service.prepare(original.id, binding, signal());
    const before = f.rows();
    if (fault === 'missing') await rm(original.directory, { recursive: true, force: true });
    else {
      await rename(original.directory, `${original.directory}-retained`);
      await mkdir(original.directory);
      await writeFile(join(original.directory, 'file.txt'), 'offline prepared source');
    }
    await expect(
      f.service.preview(binding, 'connection', 'example/repo', signal(), runtime, original.id),
    ).rejects.toThrow();
    await expect(f.service.qualifiedStatus(original.id, binding)).rejects.toThrow();
    expect(f.rows()).toEqual(before);
    expect(f.prepare).toHaveBeenCalledOnce();
  },
);
