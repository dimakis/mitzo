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
    Object.freeze({
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
