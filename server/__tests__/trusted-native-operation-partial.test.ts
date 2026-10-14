import { execFileSync } from 'node:child_process';
import type { ExecFileException, ExecFileOptions } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const boundary = vi.hoisted(() => ({ afterRef: undefined as undefined | (() => boolean) }));
vi.mock('node:child_process', async (original) => {
  const native = await original<typeof import('node:child_process')>();
  return {
    ...native,
    execFile: (
      file: string,
      args: readonly string[],
      options: ExecFileOptions,
      callback: (
        error: ExecFileException | null,
        stdout: string | Buffer,
        stderr: string | Buffer,
      ) => void,
    ) =>
      native.execFile(file, args, options, (error, stdout, stderr) => {
        if (!error && args.includes('update-ref') && boundary.afterRef?.())
          return callback(
            Object.assign(Error('Unconfirmed update-ref response'), { code: 1 }),
            stdout,
            stderr,
          );
        callback(error, stdout, stderr);
      }),
  };
});
import { executeTrustedGitCommit } from '../trusted-native-operation.js';
let root = '';
afterEach(async () => {
  boundary.afterRef = undefined;
  if (root) await rm(root, { recursive: true, force: true });
});
async function checkout() {
  root = await mkdtemp(join(tmpdir(), 'mitzo-git-partial-'));
  const repo = join(root, 'repo'),
    cwd = join(root, 'worktree');
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Mitzo Test']);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
  await writeFile(join(repo, 'file.txt'), 'original');
  execFileSync('git', ['-C', repo, 'add', 'file.txt']);
  execFileSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'original']);
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-b', 'test-branch', cwd]);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  const objects = join(repo, '.git/objects'),
    index = join(repo, '.git/worktrees/worktree/index');
  const grant = join(root, 'grant');
  await writeFile(grant, 'allowed');
  const assertCurrent = async () => {
    if ((await readFile(grant, 'utf8')) !== 'allowed') throw Error('Repository grant revoked');
  };
  await writeFile(join(cwd, 'file.txt'), 'first edit');
  return { cwd, git, objects, index, grant, assertCurrent };
}
it('leaves no corrupt loose object when authority revokes after a new destination is created', async () => {
  const f = await checkout();
  const originalObjects = new Set(await readdir(f.objects, { recursive: true }));
  let revoked = false;
  await expect(
    executeTrustedGitCommit(
      f.cwd,
      ['file.txt'],
      'cancelled',
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      undefined,
      () => {},
      async () => {
        for (const entry of await readdir(f.objects, { recursive: true })) {
          if (!originalObjects.has(entry) && (await stat(join(f.objects, entry))).isFile()) {
            await writeFile(f.grant, 'revoked');
            revoked = true;
            break;
          }
        }
        await f.assertCurrent();
      },
    ),
  ).rejects.toThrow('Repository grant revoked');
  expect(revoked).toBe(true);
  for (const entry of await readdir(f.objects, { recursive: true })) {
    if ((await stat(join(f.objects, entry))).isFile())
      expect((await readFile(join(f.objects, entry))).length).toBeGreaterThan(0);
    expect(entry).not.toContain('.mitzo-object-');
  }
  await writeFile(f.grant, 'allowed');
  await expect(
    executeTrustedGitCommit(
      f.cwd,
      ['file.txt'],
      'retry',
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      undefined,
      () => {},
      f.assertCurrent,
    ),
  ).resolves.toContain('retry');
  expect(f.git('status', '--porcelain')).toBe('');
  expect(f.git('fsck', '--no-reflogs')).not.toContain('error');
});
it.each([false, true, 'abort'] as const)(
  'keeps HEAD and index consistent after update-ref succeeds but authority revokes (reported error=%s)',
  async (reportedError) => {
    const f = await checkout(),
      before = f.git('rev-parse', 'HEAD');
    const controller = new AbortController();
    boundary.afterRef = () => {
      writeFileSync(f.grant, 'revoked');
      if (reportedError === 'abort') controller.abort();
      return reportedError !== false;
    };
    const result = executeTrustedGitCommit(
      f.cwd,
      ['file.txt'],
      'first edit',
      controller.signal,
      undefined,
      undefined,
      undefined,
      undefined,
      () => {},
      f.assertCurrent,
    );
    if (reportedError) await expect(result).rejects.toThrow();
    else await expect(result).resolves.toContain('first edit');
    expect(f.git('rev-parse', 'HEAD')).not.toBe(before);
    expect(f.git('status', '--porcelain')).toBe('');
    await expect(stat(f.index + '.lock')).rejects.toThrow();
    boundary.afterRef = undefined;
    await writeFile(f.grant, 'allowed');
    await writeFile(join(f.cwd, 'file.txt'), 'second edit');
    await expect(
      executeTrustedGitCommit(
        f.cwd,
        ['file.txt'],
        'followup',
        new AbortController().signal,
        undefined,
        undefined,
        undefined,
        undefined,
        () => {},
        f.assertCurrent,
      ),
    ).resolves.toContain('followup');
    expect(f.git('status', '--porcelain')).toBe('');
  },
);

it.each(['old', 'other'] as const)(
  'classifies an ambiguous ref response at the original %s outcome without discarding uncertainty',
  async (outcome) => {
    const f = await checkout(),
      old = f.git('rev-parse', 'HEAD');
    const index = await readFile(f.index);
    const competing = f.git(
      'commit-tree',
      f.git('rev-parse', 'HEAD^{tree}'),
      '-p',
      old,
      '-m',
      'competing owner',
    );
    boundary.afterRef = () => {
      f.git('update-ref', 'refs/heads/test-branch', outcome === 'old' ? old : competing);
      writeFileSync(f.grant, 'revoked');
      return true;
    };
    await expect(
      executeTrustedGitCommit(
        f.cwd,
        ['file.txt'],
        'uncertain',
        new AbortController().signal,
        undefined,
        undefined,
        undefined,
        undefined,
        () => {},
        f.assertCurrent,
      ),
    ).rejects.toThrow();
    expect(await readFile(f.index)).toEqual(index);
    expect(f.git('rev-parse', 'HEAD')).toBe(outcome === 'old' ? old : competing);
    if (outcome === 'old') await expect(stat(f.index + '.lock')).rejects.toThrow();
    else expect((await readFile(f.index + '.lock')).length).toBeGreaterThan(0);
  },
);

it('accepts the same immutable Git object with different valid compression', async () => {
  const f = await checkout();
  await writeFile(join(f.cwd, 'file.txt'), 'repeat '.repeat(10000));
  f.git('-c', 'core.compression=9', 'hash-object', '-w', '--', 'file.txt');
  await expect(
    executeTrustedGitCommit(
      f.cwd,
      ['file.txt'],
      'valid existing object',
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      undefined,
      () => {},
      f.assertCurrent,
    ),
  ).resolves.toContain('valid existing object');
  expect(f.git('status', '--porcelain')).toBe('');
});

it('retains the original prepared index when the checkout switches branch after the ref effect', async () => {
  const f = await checkout(),
    before = f.git('rev-parse', 'HEAD');
  const index = await readFile(f.index);
  f.git('branch', 'other-branch', before);
  boundary.afterRef = () => {
    f.git('symbolic-ref', 'HEAD', 'refs/heads/other-branch');
    return false;
  };
  await expect(
    executeTrustedGitCommit(
      f.cwd,
      ['file.txt'],
      'original branch edit',
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      undefined,
      () => {},
      f.assertCurrent,
    ),
  ).rejects.toThrow(/consistency|unconfirmed/);
  expect(f.git('symbolic-ref', 'HEAD')).toBe('refs/heads/other-branch');
  expect(f.git('rev-parse', 'refs/heads/test-branch')).not.toBe(before);
  expect(await readFile(f.index)).toEqual(index);
  expect((await readFile(f.index + '.lock')).length).toBeGreaterThan(0);
});
