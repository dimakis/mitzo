import { afterEach, expect, it, vi } from 'vitest';
import {
  access,
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const seam = vi.hoisted(() => ({
  transform: undefined as ((source: string) => string) | undefined,
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: new Proxy(actual.execFile, {
      apply(target, receiver, args) {
        const [file, argv] = args;
        if (file === 'python3' && Array.isArray(argv) && argv[0] === '-I' && seam.transform) {
          args[1] = [...argv];
          args[1][2] = seam.transform(argv[2]);
        }
        return Reflect.apply(target, receiver, args);
      },
    }),
  };
});
import { copyRepositoryTaskCheckout } from '../repository-task-copy.js';

const roots: string[] = [];
afterEach(async () => {
  seam.transform = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-task-copy-')));
  roots.push(root);
  const source = join(root, 'source'),
    parent = join(root, 'private'),
    destination = join(parent, 'task'),
    outside = join(root, 'unrelated');
  await mkdir(join(source, '.git'), { recursive: true });
  await mkdir(parent, { mode: 0o700 });
  await mkdir(join(outside, 'task'), { recursive: true });
  await writeFile(join(outside, 'owned.txt'), 'unrelated work');
  await writeFile(join(outside, 'task', 'owned.txt'), 'unrelated nested work');
  await writeFile(join(source, '.git', 'HEAD'), 'ref: refs/heads/mitzo/task\n');
  await writeFile(join(source, 'file.txt'), Buffer.alloc(1024 * 1024, 37));
  await writeFile(join(source, 'run.sh'), '#!/bin/sh\n');
  await chmod(join(source, 'run.sh'), 0o755);
  return { root, source, parent, destination, outside };
}
it('copies independent content and Git metadata with modes preserved through seed deletion', async () => {
  const f = await fixture();
  await copyRepositoryTaskCheckout(f.source, f.destination);
  for (const file of ['file.txt', '.git/HEAD', 'run.sh']) {
    const source = await stat(join(f.source, file)),
      task = await stat(join(f.destination, file));
    expect(task.ino).not.toBe(source.ino);
    expect(task.nlink).toBe(1);
    expect(task.mode & 0o777).toBe(source.mode & 0o777);
    expect(await readFile(join(f.destination, file))).toEqual(await readFile(join(f.source, file)));
  }
  await writeFile(join(f.destination, 'file.txt'), 'task edit');
  await writeFile(join(f.destination, '.git', 'HEAD'), 'ref: refs/heads/task-edited\n');
  expect((await readFile(join(f.source, 'file.txt'))).length).toBe(1024 * 1024);
  expect(await readFile(join(f.source, '.git', 'HEAD'), 'utf8')).toContain('mitzo/task');
  await rm(f.source, { recursive: true });
  expect(await readFile(join(f.destination, 'file.txt'), 'utf8')).toBe('task edit');
});
it('refuses an existing destination and preserves its files', async () => {
  const f = await fixture();
  await mkdir(f.destination);
  await writeFile(join(f.destination, 'owned.txt'), 'retained work');
  await expect(copyRepositoryTaskCheckout(f.source, f.destination)).rejects.toThrow();
  expect(await readFile(join(f.destination, 'owned.txt'), 'utf8')).toBe('retained work');
  await expect(access(join(f.destination, 'file.txt'))).rejects.toThrow();
});
it('rejects a destination outside a private canonical container before creating it', async () => {
  const f = await fixture();
  await chmod(f.parent, 0o755);
  await expect(copyRepositoryTaskCheckout(f.source, f.destination)).rejects.toThrow(
    'private canonical',
  );
  await expect(access(f.destination)).rejects.toThrow();
});
it.each(['symlink', 'hardlink'] as const)(
  'refuses a source file with a %s alias',
  async (alias) => {
    const f = await fixture();
    if (alias === 'symlink') await symlink(join(f.outside, 'owned.txt'), join(f.source, 'alias'));
    else await link(join(f.source, 'file.txt'), join(f.source, 'alias'));
    await expect(copyRepositoryTaskCheckout(f.source, f.destination)).rejects.toThrow(
      'unsupported',
    );
    expect(await readFile(join(f.outside, 'owned.txt'), 'utf8')).toBe('unrelated work');
  },
);

it.each([
  ['source', 'symlink'],
  ['destination', 'symlink'],
  ['parent', 'symlink'],
  ['source', 'directory'],
  ['destination', 'directory'],
  ['parent', 'directory'],
] as const)(
  'keeps copying on pinned descriptors when %s is replaced with a %s',
  async (replacement, kind) => {
    const f = await fixture();
    const selected = f[replacement];
    const marker = '        # Roots pinned; copying stays descriptor-relative.';
    seam.transform = (helper) => {
      expect(helper.split(marker)).toHaveLength(2);
      return helper.replace(
        marker,
        `${marker}\n        os.rename(${JSON.stringify(selected)}, ${JSON.stringify(selected + '-retained')})\n        ${kind === 'symlink' ? `os.symlink(${JSON.stringify(f.outside)}, ${JSON.stringify(selected)})` : `os.mkdir(${JSON.stringify(selected)})`}`,
      );
    };
    await expect(copyRepositoryTaskCheckout(f.source, f.destination)).rejects.toThrow(
      'identity changed',
    );
    expect((await readdir(f.outside)).sort()).toEqual(['owned.txt', 'task']);
    expect(await readdir(join(f.outside, 'task'))).toEqual(['owned.txt']);
    expect(await readFile(join(f.outside, 'owned.txt'), 'utf8')).toBe('unrelated work');
    expect(await readFile(join(f.outside, 'task', 'owned.txt'), 'utf8')).toBe(
      'unrelated nested work',
    );
    const retainedTask =
      replacement === 'destination'
        ? f.destination + '-retained'
        : replacement === 'parent'
          ? join(f.parent + '-retained', 'task')
          : f.destination;
    expect((await readFile(join(retainedTask, 'file.txt'))).length).toBe(1024 * 1024);
    expect(await readFile(join(retainedTask, '.git', 'HEAD'), 'utf8')).toContain('mitzo/task');
    if (kind === 'directory') expect(await readdir(selected)).toEqual([]);
  },
);

it.each(['source', 'destination'] as const)(
  'keeps nested %s traversal anchored after a pinned directory is replaced',
  async (replacement) => {
    const f = await fixture();
    const selected = join(f[replacement], '.git');
    const marker =
      '                        # Nested roots pinned; copying stays descriptor-relative.';
    seam.transform = (helper) => {
      expect(helper.split(marker)).toHaveLength(2);
      return helper.replace(
        marker,
        `${marker}\n                        if entry == '.git':\n                            os.rename(${JSON.stringify(selected)}, ${JSON.stringify(selected + '-retained')})\n                            os.symlink(${JSON.stringify(f.outside)}, ${JSON.stringify(selected)})`,
      );
    };
    await expect(copyRepositoryTaskCheckout(f.source, f.destination)).rejects.toThrow('changed');
    expect((await readdir(f.outside)).sort()).toEqual(['owned.txt', 'task']);
    expect(await readdir(join(f.outside, 'task'))).toEqual(['owned.txt']);
    const copiedGit =
      replacement === 'source' ? join(f.destination, '.git') : selected + '-retained';
    expect(await readFile(join(copiedGit, 'HEAD'), 'utf8')).toContain('mitzo/task');
  },
);

it.each(['symlink', 'file'] as const)(
  'refuses replacing an inspected file with a %s before opening it',
  async (replacement) => {
    const f = await fixture();
    const selected = join(f.source, 'file.txt');
    const marker = '                    # Open only the inspected source file.';
    seam.transform = (helper) => {
      expect(helper.split(marker)).toHaveLength(2);
      return helper.replace(
        marker,
        `${marker}\n                    if entry == 'file.txt':\n                        os.rename(${JSON.stringify(selected)}, ${JSON.stringify(selected + '-retained')})\n                        ${replacement === 'symlink' ? `os.symlink(${JSON.stringify(join(f.outside, 'owned.txt'))}, ${JSON.stringify(selected)})` : `with open(${JSON.stringify(selected)}, 'wb') as replacement_file:\n                            replacement_file.write(b'replaced')`}`,
      );
    };
    await expect(copyRepositoryTaskCheckout(f.source, f.destination)).rejects.toThrow();
    await expect(access(join(f.destination, 'file.txt'))).rejects.toThrow();
    expect(await readFile(join(f.outside, 'owned.txt'), 'utf8')).toBe('unrelated work');
  },
);

it('refuses a source FIFO without waiting for a writer', async () => {
  const f = await fixture();
  execFileSync('mkfifo', [join(f.source, 'fifo')]);
  await expect(copyRepositoryTaskCheckout(f.source, f.destination)).rejects.toThrow('unsupported');
});

it.each([
  ['MAX_BYTES = 128 * 1024 * 1024', 'MAX_BYTES = 65536'],
  ['MAX_ENTRIES = 100000', 'MAX_ENTRIES = 2'],
])('enforces streamed copy bounds (%s)', async (setting, reduced) => {
  const f = await fixture();
  seam.transform = (helper) => {
    expect(helper.split(setting)).toHaveLength(2);
    return helper.replace(setting, reduced);
  };
  await expect(copyRepositoryTaskCheckout(f.source, f.destination)).rejects.toThrow(
    'supported bounds',
  );
  expect((await readdir(f.outside)).sort()).toEqual(['owned.txt', 'task']);
});
