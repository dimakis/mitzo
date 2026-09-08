import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const fault = vi.hoisted(() => ({ code: '', path: '' }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const errorFor = (args: readonly string[]) =>
    fault.code && args[1] === fault.path && args.includes('rev-parse')
      ? Object.assign(new Error(`validation failed: ${fault.code}`), { code: fault.code })
      : undefined;
  const execFile = (
    file: string,
    args: string[],
    options: object,
    callback: (...args: unknown[]) => void,
  ) => {
    const error = errorFor(args);
    if (error) return callback(error, '', '');
    return actual.execFile(file, args, options, callback);
  };
  Object.defineProperty(execFile, Symbol.for('nodejs.util.promisify.custom'), {
    value: (file: string, args: string[], options: object) =>
      new Promise((resolve, reject) => {
        execFile(file, args, options, (error, stdout, stderr) => {
          if (error) reject(error);
          else resolve({ stdout, stderr });
        });
      }),
  });
  return {
    ...actual,
    execFileSync: (file: string, args: string[], options: object) => {
      const error = errorFor(args);
      if (error) throw error;
      return actual.execFileSync(file, args, options);
    },
    execFile,
  };
});
vi.mock('../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
import { createWorktree, createWorktreeAsync } from '../worktree.js';

describe.each([
  ['sync', createWorktree],
  ['async', createWorktreeAsync],
] as const)('%s worktree preservation', (_name, create) => {
  let root: string;
  let repo: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mitzo-preservation-'));
    repo = join(root, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'commit', '--allow-empty', '-m', 'initial');
  });
  afterEach(() => {
    fault.code = '';
    fault.path = '';
    rmSync(root, { recursive: true, force: true });
  });

  it.each(['ETIMEDOUT', 'ENOENT', 'EACCES'])('preserves dirty worktree on %s', async (code) => {
    const path = await create('session', repo);
    writeFileSync(join(path, 'unfinished.txt'), 'keep this work');
    const tip = git(path, 'rev-parse', 'HEAD');
    fault.path = path;
    fault.code = code;
    await expect(Promise.resolve().then(() => create('session', repo))).rejects.toThrow();
    expect(readFileSync(join(path, 'unfinished.txt'), 'utf8')).toBe('keep this work');
    fault.code = '';
    expect(git(path, 'rev-parse', 'HEAD')).toBe(tip);
  });

  it.each(['inside', 'outside'])(
    'preserves non-worktree directory %s the repository',
    async (location) => {
      const dir =
        location === 'inside' ? join(repo, '.claude', 'worktrees') : join(root, 'worktrees');
      const path = join(dir, 'session');
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'unfinished.txt'), 'keep this work');
      await expect(
        Promise.resolve().then(() => create('session', repo, { dir })),
      ).rejects.toThrow();
      expect(readFileSync(join(path, 'unfinished.txt'), 'utf8')).toBe('keep this work');
    },
  );

  it('reattaches a divergent session branch without losing commits', async () => {
    git(repo, 'checkout', '-b', 'session/session');
    writeFileSync(join(repo, 'committed.txt'), 'preserved commit');
    git(repo, 'add', 'committed.txt');
    git(repo, 'commit', '-m', 'session work');
    const tip = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', 'main');
    const path = await create('session', repo);
    expect(git(path, 'rev-parse', 'HEAD')).toBe(tip);
    expect(readFileSync(join(path, 'committed.txt'), 'utf8')).toBe('preserved commit');
  });

  it('reuses a valid dirty worktree without changing files', async () => {
    const path = await create('session', repo);
    writeFileSync(join(path, 'unfinished.txt'), 'keep this work');
    expect(await create('session', repo)).toBe(path);
    expect(readFileSync(join(path, 'unfinished.txt'), 'utf8')).toBe('keep this work');
  });
});
