import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  realpath,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountBinding } from '@mitzo/protocol';
import { RepositoryWorkspaces } from '../repository-workspaces.js';
import { restoreWorkspaceArchive } from '../workspace-preservation.js';

let root: string | undefined;
const services: RepositoryWorkspaces[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) service.close();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});
const binding = {
  accountId: 'offline',
  provider: 'openai',
  model: 'fixture',
  profileRevision: 'revision',
} as AccountBinding;
async function fixture() {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-owned-retirement-')));
  const source = join(root, 'source');
  await mkdir(source);
  const git = (...args: string[]) =>
    execFileSync(
      '/usr/bin/git',
      [
        '-C',
        source,
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'user.name=Offline',
        '-c',
        'user.email=offline@example.invalid',
        ...args,
      ],
      {
        encoding: 'utf8',
        env: {
          PATH: '/usr/bin:/bin',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
        },
      },
    ).trim();
  git('init', '-q', '-b', 'main');
  await writeFile(join(source, 'work.txt'), 'private source');
  git('add', '.');
  git('commit', '-qm', 'unique');
  const preview = {
    repository: 'example/repo',
    baseBranch: 'main',
    baseOid: git('rev-parse', 'HEAD'),
  };
  const dependencies: ConstructorParameters<typeof RepositoryWorkspaces>[1] = {
    authorize: async () => ({ revision: 1, allowedBaseBranches: ['main'] }),
    inspect: async () => preview,
    prepare: async (_preview, directory, featureBranch) => {
      await cp(source, directory, { recursive: true });
      execFileSync('/usr/bin/git', ['-C', directory, 'checkout', '-qb', featureBranch], {
        env: {
          PATH: '/usr/bin:/bin',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
        },
      });
      return { ...preview, directory, featureBranch };
    },
    verify: async () => {},
  };
  const service = new RepositoryWorkspaces(join(root, 'private'), dependencies);
  services.push(service);
  const selected = await service.preview(
    binding,
    'connection',
    'example/repo',
    new AbortController().signal,
  );
  await service.prepare(selected.id, binding, new AbortController().signal);
  return {
    service,
    id: selected.id,
    reopen: () => {
      service.close();
      services.splice(services.indexOf(service), 1);
      const next = new RepositoryWorkspaces(join(root!, 'private'), dependencies);
      services.push(next);
      return next;
    },
  };
}
it('wires explicit unused discard to verified preservation and retained retirement metadata', async () => {
  const f = await fixture();
  const assertCurrent = vi.fn(async () => {});
  await f.service.discard(f.id, binding, { assertCurrent });
  const record = f.service.get(f.id);
  expect(record.state).toBe('discarded');
  expect(record.retirement?.receipt.state).toBe('retired');
  expect(assertCurrent.mock.calls.length).toBeGreaterThan(2);
  await expect(lstat(join(root!, 'private', f.id))).rejects.toMatchObject({ code: 'ENOENT' });
  const restored = join(root!, 'restored');
  await restoreWorkspaceArchive(record.retirement!.receipt.archive!, restored);
  expect(await readFile(join(restored, 'mgmt', 'work.txt'), 'utf8')).toBe('private source');
  expect(f.service.lifecycleClaims()).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: f.id, state: 'retired' })]),
  );
});
it('does not retire an unused preparation after current operator authorization is revoked', async () => {
  const f = await fixture();
  await expect(
    f.service.discard(f.id, binding, {
      assertCurrent: async () => {
        throw Error('Operator revoked');
      },
    }),
  ).rejects.toThrow('Operator revoked');
  expect(f.service.get(f.id).state).toBe('ready');
  expect(await lstat(join(root!, 'private', f.id))).toBeDefined();
});

it('explicitly retires and restores a previously used independent task with append-only identities and unchanged history', async () => {
  const f = await fixture();
  const tasks = join(root!, 'tasks');
  await mkdir(tasks, { mode: 0o700 });
  const claimed = await f.service.claim(f.id, binding, 'conversation', tasks, false);
  const path = claimed.directory!;
  await writeFile(join(path, 'work.txt'), 'later task edits');
  await writeFile(join(path, '.gitignore'), 'ignored.bin\n');
  await writeFile(join(path, 'ignored.bin'), 'meaningful ignored data');
  const originalTask = structuredClone(claimed.taskIdentity);
  const authority = { assertCurrent: async () => {}, assertTaskStopped: () => {} };
  await f.service.retireTask(f.id, binding, authority);
  const archived = f.service.get(f.id);
  expect(archived.conversationId).toBe('conversation');
  expect(archived.retirement?.receipt.state).toBe('retired');
  await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  await f.service.restoreTask(f.id, binding, authority);
  const restored = f.service.get(f.id);
  expect(restored.conversationId).toBe('conversation');
  expect(restored.restorations).toHaveLength(1);
  expect(restored.restorations![0].previousTaskIdentity).toEqual(originalTask);
  expect(restored.taskIdentity!.root).not.toEqual(originalTask!.root);
  expect(restored.restorations![0].taskIdentity).toEqual(restored.taskIdentity);
  expect(await readFile(join(path, 'work.txt'), 'utf8')).toBe('later task edits');
  expect(await readFile(join(path, 'ignored.bin'), 'utf8')).toBe('meaningful ignored data');
  await expect(f.service.validateHostTask('conversation', path)).resolves.toBeDefined();
});
it('protects used tasks unless the current owner proves execution stopped and references can transfer', async () => {
  const f = await fixture();
  const tasks = join(root!, 'tasks');
  await mkdir(tasks, { mode: 0o700 });
  const claimed = await f.service.claim(f.id, binding, 'conversation', tasks, false);
  await expect(
    f.service.retireTask(f.id, binding, { assertCurrent: async () => {} }),
  ).rejects.toThrow(/stopped|authority/i);
  expect(await readFile(join(claimed.directory!, 'work.txt'), 'utf8')).toBe('private source');
});

it('does not adopt an existing directory during a fresh restore without its restoration journal', async () => {
  const f = await fixture();
  const tasks = join(root!, 'tasks');
  await mkdir(tasks, { mode: 0o700 });
  const claimed = await f.service.claim(f.id, binding, 'conversation', tasks, false);
  const authority = { assertCurrent: async () => {}, assertTaskStopped: () => {} };
  await f.service.retireTask(f.id, binding, authority);
  await restoreWorkspaceArchive(
    f.service.get(f.id).retirement!.receipt.archive!,
    claimed.directory!,
  );
  await expect(f.service.restoreTask(f.id, binding, authority)).rejects.toThrow(
    /existing|journal/i,
  );
  expect(f.service.get(f.id).restorations).toBeUndefined();
});
it('recovers a verified retirement after operator loss and an expired durable lease across restart', async () => {
  const f = await fixture();
  let revoked = false;
  await expect(
    f.service.discard(f.id, binding, {
      assertCurrent: async (record) => {
        if (record.retirement?.receipt.state === 'verified') {
          revoked = true;
          throw Error('Operator revoked');
        }
      },
    }),
  ).rejects.toThrow('Operator revoked');
  expect(revoked).toBe(true);
  const receipt = f.service.get(f.id).retirement!.receipt;
  expect(receipt.state).toBe('verified');
  const restarted = f.reopen();
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 400000);
  try {
    await restarted.discard(f.id, binding, { assertCurrent: async () => {} });
  } finally {
    clock.mockRestore();
  }
  expect(restarted.get(f.id).retirement!.receipt).toMatchObject({
    state: 'retired',
    operationId: receipt.operationId,
    archive: receipt.archive,
  });
});

it('resumes an archiving task after restart without reusing or discarding the interrupted attempt', async () => {
  const f = await fixture();
  const tasks = join(root!, 'tasks');
  await mkdir(tasks, { mode: 0o700 });
  const claimed = await f.service.claim(f.id, binding, 'conversation', tasks, false);
  let partial: string | undefined;
  await expect(
    f.service.retireTask(f.id, binding, {
      assertTaskStopped: () => {},
      assertCurrent: async (record) => {
        const receipt = record.retirement?.receipt;
        if (receipt?.state !== 'archiving' || !receipt.archiveAttempts?.length) return;
        const path = join(
          root!,
          'private',
          'archives',
          receipt.operationId,
          receipt.archiveAttempts.at(-1)!,
        );
        const created = await lstat(path).catch(() => undefined);
        if (created) {
          partial = path;
          await writeFile(join(path, 'partial-evidence'), 'interrupted archive attempt');
          throw Error('Interrupted archive');
        }
      },
    }),
  ).rejects.toThrow('Interrupted archive');
  expect(partial).toBeDefined();
  const restarted = f.reopen();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 400000);
  try {
    await restarted.retireTask(f.id, binding, {
      assertCurrent: async () => {},
      assertTaskStopped: () => {},
    });
  } finally {
    clock.mockRestore();
  }
  expect(restarted.get(f.id).retirement!.receipt.state).toBe('retired');
  expect(restarted.get(f.id).retirement!.receipt.archiveAttempts).toHaveLength(2);
  expect(await readFile(join(partial!, 'partial-evidence'), 'utf8')).toBe(
    'interrupted archive attempt',
  );
  await expect(lstat(claimed.directory!)).rejects.toMatchObject({ code: 'ENOENT' });
});
it.each(['partial-copy', 'verified-copy', 'published'] as const)(
  'resumes a journalled restoration after %s interruption and lease expiry',
  async (phase) => {
    const f = await fixture();
    const tasks = join(root!, 'tasks');
    await mkdir(tasks, { mode: 0o700 });
    const claimed = await f.service.claim(f.id, binding, 'conversation', tasks, false);
    const authority = { assertCurrent: async () => {}, assertTaskStopped: () => {} };
    await f.service.retireTask(f.id, binding, authority);
    const archive = f.service.get(f.id).retirement!.receipt.archive!;
    let interruptedScratch: string | undefined;
    let stopped = false;
    await expect(
      f.service.restoreTask(f.id, binding, {
        assertTaskStopped: () => {},
        assertCurrent: async (record) => {
          if (record.retirement?.disposition !== 'restoring' || stopped) return;
          const scratch = join(archive.directory, `restore-attempt-${record.retirement.leaseId}`);
          if (phase === 'partial-copy') {
            // Fault at the durable-journal/copy boundary: the prior process left
            // owned incomplete scratch, never a partial live checkout.
            await mkdir(scratch, { mode: 0o700 });
            await writeFile(join(scratch, 'partial-evidence'), 'interrupted copy');
          } else if (phase === 'verified-copy') {
            if (!(await lstat(scratch).catch(() => undefined))) return;
          } else if (!(await lstat(claimed.directory!).catch(() => undefined))) return;
          interruptedScratch = scratch;
          stopped = true;
          throw Error('Interrupted restore');
        },
      }),
    ).rejects.toThrow('Interrupted restore');
    expect(stopped).toBe(true);
    expect(f.service.get(f.id).retirement!.disposition).toBe('restoring');
    if (phase !== 'published')
      await expect(lstat(claimed.directory!)).rejects.toMatchObject({ code: 'ENOENT' });
    const restarted = f.reopen();
    await expect(restarted.restoreTask(f.id, binding, authority)).rejects.toThrow(
      /lease is still active/i,
    );
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 400000);
    try {
      await restarted.restoreTask(f.id, binding, authority);
    } finally {
      clock.mockRestore();
    }
    const restored = restarted.get(f.id);
    expect(restored.retirement!.disposition).toBe('restored');
    expect(restored.retirement!.restorationAttempts).toHaveLength(2);
    expect(restored.restorations).toHaveLength(1);
    expect(await readFile(join(claimed.directory!, 'work.txt'), 'utf8')).toBe('private source');
    if (phase === 'partial-copy')
      expect(await readFile(join(interruptedScratch!, 'partial-evidence'), 'utf8')).toBe(
        'interrupted copy',
      );
    if (phase === 'verified-copy') expect(await readdir(interruptedScratch!)).toContain('work.txt');
  },
);

it('refuses a byte-identical replacement root after publication and preserves both trees', async () => {
  const f = await fixture();
  const tasks = join(root!, 'tasks');
  await mkdir(tasks, { mode: 0o700 });
  const claimed = await f.service.claim(f.id, binding, 'conversation', tasks, false);
  const authority = { assertCurrent: async () => {}, assertTaskStopped: () => {} };
  await f.service.retireTask(f.id, binding, authority);
  const archive = f.service.get(f.id).retirement!.receipt.archive!;
  const preserved = join(root!, 'published-preserved');
  let replaced = false;
  await expect(
    f.service.restoreTask(f.id, binding, {
      assertTaskStopped: () => {},
      assertCurrent: async (record) => {
        if (
          replaced ||
          record.retirement?.disposition !== 'restoring' ||
          !(await lstat(claimed.directory!).catch(() => undefined))
        )
          return;
        replaced = true;
        await rename(claimed.directory!, preserved);
        await restoreWorkspaceArchive(archive, claimed.directory!);
      },
    }),
  ).rejects.toThrow(/publication identity changed/i);
  expect(replaced).toBe(true);
  expect(f.service.get(f.id).retirement!.disposition).toBe('restoring');
  expect(f.service.get(f.id).restorations).toBeUndefined();
  for (const path of [preserved, claimed.directory!])
    expect(await readFile(join(path, 'work.txt'), 'utf8')).toBe('private source');
});
