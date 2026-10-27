import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  lstat,
  realpath,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  retireOwnedWorkspace,
  removePreservedWorkspace,
  restoreWorkspaceArchive,
  type WorkspaceRetirementOwner,
  type WorkspaceRetirementReceipt,
} from '../workspace-preservation.js';

import { workspacePreservationProgram } from '../workspace-preservation-helper.js';

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'core.hooksPath=/dev/null', ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  }).trim();
async function fixture() {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-preservation-')));
  const directory = join(root, 'task'),
    archives = join(root, 'archives');
  await mkdir(directory, { mode: 0o700 });
  await mkdir(archives, { mode: 0o700 });
  git(directory, 'init', '-q', '-b', 'task');
  git(directory, 'config', 'user.name', 'Offline');
  git(directory, 'config', 'user.email', 'offline@example.invalid');
  await writeFile(join(directory, 'tracked.txt'), 'original');
  await writeFile(join(directory, '.gitignore'), 'ignored.bin\n');
  git(directory, 'add', '.');
  git(directory, 'commit', '-qm', 'unique unpublished work');
  const head = git(directory, 'rev-parse', 'HEAD');
  await writeFile(join(directory, 'tracked.txt'), 'edited');
  await writeFile(join(directory, 'untracked.txt'), 'new private work');
  await writeFile(join(directory, 'ignored.bin'), 'meaningful ignored output');
  const info = await lstat(directory);
  let current = true;
  const writes: unknown[] = [];
  const owner: WorkspaceRetirementOwner = Object.freeze({
    operationId: 'retirement-one',
    workspaceId: 'workspace-one',
    directory,
    rootIdentity: { dev: info.dev, ino: info.ino },
    archiveRoot: archives,
    assertCurrent: async () => {
      if (!current) throw Error('Lease changed');
    },
    record: async (receipt: unknown) => {
      writes.push(receipt);
    },
    remove: async (expected: { dev: number; ino: number }) => {
      if (!current) throw Error('Lease changed');
      const actual = await lstat(directory);
      expect({ dev: actual.dev, ino: actual.ino }).toEqual(expected);
      await rm(directory, { recursive: true });
    },
  });
  return {
    directory,
    archives,
    owner,
    head,
    writes,
    revoke: () => {
      current = false;
    },
  };
}
it('verifies a restorable private archive before removing an owned task with unique commits and all files', async () => {
  const f = await fixture();
  const result = await retireOwnedWorkspace(f.owner);
  expect(result.state).toBe('retired');
  await expect(lstat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  const restored = join(root!, 'restored');
  if (!result.archive) throw new Error('Retired workspace is missing its archive');
  await restoreWorkspaceArchive(result.archive, restored);
  expect(git(restored, 'rev-parse', 'HEAD')).toBe(f.head);
  expect(await readFile(join(restored, 'tracked.txt'), 'utf8')).toBe('edited');
  expect(await readFile(join(restored, 'untracked.txt'), 'utf8')).toBe('new private work');
  expect(await readFile(join(restored, 'ignored.bin'), 'utf8')).toBe('meaningful ignored output');
  expect(f.writes.map((value) => (value as { state: string }).state)).toEqual([
    'archiving',
    'verified',
    'retired',
  ]);
});
it('retains source and verified archive if the owner lease changes before removal', async () => {
  const f = await fixture();
  const owner = Object.freeze({
    ...f.owner,
    record: async (receipt: { state: string }) => {
      if (receipt.state === 'verified') f.revoke();
    },
  });
  await expect(retireOwnedWorkspace(owner)).rejects.toThrow('Lease changed');
  expect(await readFile(join(f.directory, 'ignored.bin'), 'utf8')).toContain('meaningful');
  expect(await readdir(f.archives)).toContain('retirement-one');
});
it('refuses root replacement and does not remove either directory', async () => {
  const f = await fixture();
  await rename(f.directory, f.directory + '-original');
  await mkdir(f.directory);
  await expect(retireOwnedWorkspace(f.owner)).rejects.toThrow(/identity/i);
  expect(await lstat(f.directory + '-original')).toBeDefined();
  expect(await lstat(f.directory)).toBeDefined();
});
it('refuses linked Git stores rather than creating an incomplete archive', async () => {
  const f = await fixture();
  await rm(join(f.directory, '.git'), { recursive: true });
  await writeFile(join(f.directory, '.git'), 'gitdir: /external/store');
  const remove = vi.fn();
  await expect(retireOwnedWorkspace(Object.freeze({ ...f.owner, remove }))).rejects.toThrow(
    /independent Git/i,
  );
  expect(remove).not.toHaveBeenCalled();
});

it('refuses a changed source after verification and retains both copies', async () => {
  const f = await fixture();
  const owner = Object.freeze({
    ...f.owner,
    record: async (receipt: { state: string }) => {
      if (receipt.state === 'verified')
        await writeFile(join(f.directory, 'untracked.txt'), 'later work');
    },
  });
  await expect(retireOwnedWorkspace(owner)).rejects.toThrow(/changed after preservation/i);
  expect(await readFile(join(f.directory, 'untracked.txt'), 'utf8')).toBe('later work');
});
it('refuses a corrupted archive before restoring or removing any source', async () => {
  const f = await fixture();
  const receipt = await retireOwnedWorkspace(f.owner);
  await writeFile(join(receipt.archive!.directory, 'checkout', 'ignored.bin'), 'corruption');
  await expect(
    restoreWorkspaceArchive(receipt.archive!, join(root!, 'bad-restore')),
  ).rejects.toThrow(/verification failed/i);
  await expect(lstat(join(root!, 'bad-restore'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('reconciles removal completed before its final receipt without repeating deletion', async () => {
  const f = await fixture();
  let retained: Parameters<WorkspaceRetirementOwner['record']>[0] | undefined;
  const remove = vi.fn(f.owner.remove);
  const owner = Object.freeze({
    ...f.owner,
    remove,
    record: async (receipt: Parameters<WorkspaceRetirementOwner['record']>[0]) => {
      if (receipt.state === 'retired') throw Error('Crash after removal');
      retained = receipt;
    },
  });
  await expect(retireOwnedWorkspace(owner)).rejects.toThrow('Crash after removal');
  expect(retained?.state).toBe('verified');
  const result = await retireOwnedWorkspace(
    Object.freeze({ ...f.owner, remove, previousReceipt: retained }),
  );
  expect(result.state).toBe('retired');
  expect(remove).toHaveBeenCalledOnce();
});

it('retains external writes arriving after the final archive proof instead of unlinking them', async () => {
  const f = await fixture();
  const receipt = await retireOwnedWorkspace(Object.freeze({ ...f.owner, remove: async () => {} }));
  const archive = receipt.archive!;
  // Deterministic external-editor fault at the final proof/effect boundary.
  const program = workspacePreservationProgram.replace(
    "    path=r['source']; parent=os.path.dirname(path); name=os.path.basename(path)",
    "    open(os.path.join(r['source'],'late.txt'),'w').write('later external work')\n    open(os.path.join(r['source'],'tracked.txt'),'w').write('later edit')\n    path=r['source']; parent=os.path.dirname(path); name=os.path.basename(path)",
  );
  expect(program).not.toBe(workspacePreservationProgram);
  execFileSync('/usr/bin/python3', ['-I', '-c', program], {
    input: JSON.stringify({
      mode: 'remove',
      source: f.directory,
      identity: f.owner.rootIdentity,
      retainedSource: join(archive.directory, 'retained-source'),
      proof: { sha256: archive.sha256, files: archive.files, bytes: archive.bytes },
    }),
    env: { PATH: '/usr/bin:/bin' },
  });
  expect(await readFile(join(archive.directory, 'retained-source', 'late.txt'), 'utf8')).toBe(
    'later external work',
  );
  expect(await readFile(join(archive.directory, 'retained-source', 'tracked.txt'), 'utf8')).toBe(
    'later edit',
  );
  await expect(restoreWorkspaceArchive(archive, join(root!, 'restore-late'))).rejects.toThrow(
    /retained source changed/i,
  );
});
it('retires by retaining the original tree and restores an unchanged archive', async () => {
  const f = await fixture();
  const receipt = await retireOwnedWorkspace(
    Object.freeze<WorkspaceRetirementOwner>({
      ...f.owner,
      remove: (identity, archive) => removePreservedWorkspace(f.directory, identity, archive),
    }),
  );
  await expect(lstat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  const retained = await lstat(join(receipt.archive!.directory, 'retained-source'));
  expect({ dev: retained.dev, ino: retained.ino }).toEqual(f.owner.rootIdentity);
  const restored = join(root!, 'restore-retained');
  await restoreWorkspaceArchive(receipt.archive!, restored);
  expect(await readFile(join(restored, 'tracked.txt'), 'utf8')).toBe('edited');
});

it('retries an interrupted archive in a fresh journalled attempt and retains the partial tree', async () => {
  const f = await fixture();
  const config = await readFile(join(f.directory, '.git', 'config'));
  await rm(join(f.directory, '.git', 'config'));
  const { symlink } = await import('node:fs/promises');
  await symlink('../tracked.txt', join(f.directory, '.git', 'config'));
  await expect(retireOwnedWorkspace(f.owner)).rejects.toThrow(/independent Git/i);
  const previous = f.writes.at(-1) as WorkspaceRetirementReceipt;
  expect(previous.state).toBe('archiving');
  const partial = join(f.archives, previous.operationId, previous.archiveAttempts![0], 'checkout');
  const partialIdentity = await lstat(partial);
  await rm(join(f.directory, '.git', 'config'));
  await writeFile(join(f.directory, '.git', 'config'), config);
  const recovered = await retireOwnedWorkspace(
    Object.freeze({ ...f.owner, previousReceipt: previous }),
  );
  expect(recovered.archiveAttempts).toHaveLength(2);
  expect(recovered.archive!.directory).not.toBe(join(partial, '..'));
  expect((await lstat(partial)).ino).toBe(partialIdentity.ino);
  await restoreWorkspaceArchive(recovered.archive!, join(root!, 'recovered'));
  expect(await readFile(join(root!, 'recovered', 'ignored.bin'), 'utf8')).toBe(
    'meaningful ignored output',
  );
});
it('recovers legacy archiving receipts without replacing their partial archive evidence', async () => {
  const f = await fixture();
  const operation = join(f.archives, f.owner.operationId);
  await mkdir(operation, { mode: 0o700 });
  await mkdir(join(operation, 'checkout'));
  await writeFile(join(operation, 'checkout', 'partial.txt'), 'retained incomplete attempt');
  const previousReceipt: WorkspaceRetirementReceipt = {
    version: 1,
    operationId: f.owner.operationId,
    workspaceId: f.owner.workspaceId,
    directory: f.directory,
    rootIdentity: f.owner.rootIdentity,
    state: 'archiving',
  };
  const recovered = await retireOwnedWorkspace(Object.freeze({ ...f.owner, previousReceipt }));
  expect(recovered.state).toBe('retired');
  expect(await readFile(join(operation, 'checkout', 'partial.txt'), 'utf8')).toBe(
    'retained incomplete attempt',
  );
});
it('keeps interrupted restore copies private and retries without touching their partial evidence', async () => {
  const f = await fixture();
  const receipt = await retireOwnedWorkspace(f.owner);
  const archive = receipt.archive!;
  const scratch = join(archive.directory, 'restore-attempt-9b795d02-45ed-4a95-a338-2062046504f0');
  const destination = join(root!, 'restored');
  const program = workspacePreservationProgram.replace(
    '                        h.update(data)',
    "                        if target is not None: fail('Interrupted copy')\n                        h.update(data)",
  );
  expect(program).not.toBe(workspacePreservationProgram);
  expect(() =>
    execFileSync('/usr/bin/python3', ['-I', '-c', program], {
      input: JSON.stringify({
        mode: 'restore',
        source: join(archive.directory, 'checkout'),
        destination: scratch,
        proof: { sha256: archive.sha256, files: archive.files, bytes: archive.bytes },
      }),
      env: { PATH: '/usr/bin:/bin' },
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
  ).toThrow();
  const partialIdentity = await lstat(scratch);
  await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  await restoreWorkspaceArchive(archive, destination);
  expect((await lstat(scratch)).ino).toBe(partialIdentity.ino);
  expect(await readFile(join(destination, 'ignored.bin'), 'utf8')).toBe(
    'meaningful ignored output',
  );
});
it('atomically refuses a destination collision appearing at publication, retaining both trees', async () => {
  const f = await fixture();
  const receipt = await retireOwnedWorkspace(f.owner);
  const archive = receipt.archive!;
  const destination = join(root!, 'restore-collision');
  let collisionInode: number | undefined;
  const id = 'cf18a9c9-d92a-4e16-bfee-988e9e22a3cc';
  await expect(
    restoreWorkspaceArchive(archive, destination, {
      id,
      assertCurrent: async () => {
        const scratch = join(archive.directory, `restore-attempt-${id}`);
        const copied = await lstat(scratch).catch(() => undefined);
        if (copied && !collisionInode) {
          await mkdir(destination);
          collisionInode = (await lstat(destination)).ino;
        }
      },
    }),
  ).rejects.toThrow(/exist/i);
  expect((await lstat(destination)).ino).toBe(collisionInode);
  expect(await readdir(destination)).toEqual([]);
  expect(
    await readFile(join(archive.directory, `restore-attempt-${id}`, 'ignored.bin'), 'utf8'),
  ).toBe('meaningful ignored output');
});
