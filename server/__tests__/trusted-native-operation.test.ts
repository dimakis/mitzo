import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeTrustedGitCommit, trustedGitHubReadRequest } from '../trusted-native-operation.js';

describe('trusted native Git operation', () => {
  let root = '';
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('creates objects for an exact file list in a linked worktree', async () => {
    root = await mkdtemp(join(tmpdir(), 'mitzo-trusted-git-'));
    const repo = join(root, 'repo');
    const worktree = join(root, 'worktree');
    execFileSync('git', ['init', repo]);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Mitzo Test']);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
    await writeFile(join(repo, 'initial.txt'), 'initial');
    execFileSync('git', ['-C', repo, 'add', 'initial.txt']);
    execFileSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', 'commit', '-m', 'initial']);
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-b', 'test-branch', worktree]);
    await writeFile(join(worktree, 'approved.txt'), 'approved');
    const output = await executeTrustedGitCommit(
      worktree,
      ['approved.txt'],
      'test: trusted commit',
      new AbortController().signal,
    );
    expect(output).toContain('test: trusted commit');
    expect(
      execFileSync('git', ['-C', worktree, 'show', 'HEAD:approved.txt'], { encoding: 'utf8' }),
    ).toBe('approved');
  });

  it('does not execute repository-controlled filters, hooks, or fsmonitor commands', async () => {
    root = await mkdtemp(join(tmpdir(), 'mitzo-trusted-git-adversarial-'));
    const repo = join(root, 'repo');
    const worktree = join(root, 'worktree');
    const marker = join(root, 'HOST_CODE_EXECUTED');
    execFileSync('git', ['init', repo]);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Mitzo Test']);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
    await writeFile(join(repo, 'initial.txt'), 'initial');
    execFileSync('git', ['-C', repo, 'add', 'initial.txt']);
    execFileSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', 'commit', '-m', 'initial']);
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-b', 'adversarial', worktree]);
    const script = join(root, 'host-code.sh');
    await writeFile(script, `#!/bin/sh\ntouch '${marker}'\ncat\n`);
    await chmod(script, 0o700);
    execFileSync('git', ['-C', worktree, 'config', 'filter.evil.clean', script]);
    execFileSync('git', ['-C', worktree, 'config', 'filter.evil.required', 'true']);
    execFileSync('git', ['-C', worktree, 'config', 'core.fsmonitor', script]);
    const hooks = join(repo, '.git', 'hooks');
    await mkdir(hooks, { recursive: true });
    await writeFile(join(hooks, 'reference-transaction'), `#!/bin/sh\ntouch '${marker}'\n`);
    await chmod(join(hooks, 'reference-transaction'), 0o700);
    await writeFile(join(worktree, '.gitattributes'), '*.txt filter=evil\n');
    await writeFile(join(worktree, 'approved.txt'), 'approved');
    await executeTrustedGitCommit(
      worktree,
      ['approved.txt'],
      'test: isolated metadata',
      new AbortController().signal,
    );
    await expect(readFile(marker)).rejects.toThrow();
    expect(
      execFileSync('git', ['-C', worktree, 'show', 'HEAD:approved.txt'], { encoding: 'utf8' }),
    ).toBe('approved');
  });

  it('refuses a concurrent index operation', async () => {
    root = await mkdtemp(join(tmpdir(), 'mitzo-trusted-git-lock-'));
    const repo = join(root, 'repo');
    const worktree = join(root, 'worktree');
    execFileSync('git', ['init', repo]);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Mitzo Test']);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
    execFileSync('git', [
      '-C',
      repo,
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-m',
      'initial',
    ]);
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-b', 'locked', worktree]);
    const admin = (await readFile(join(worktree, '.git'), 'utf8')).trim().slice('gitdir: '.length);
    await writeFile(join(admin, 'index.lock'), 'busy');
    await writeFile(join(worktree, 'approved.txt'), 'approved');
    await expect(
      executeTrustedGitCommit(worktree, ['approved.txt'], 'blocked', new AbortController().signal),
    ).rejects.toThrow('index is busy');
  });

  it('rejects a swapped linked-worktree marker whose registration points elsewhere', async () => {
    root = await mkdtemp(join(tmpdir(), 'mitzo-trusted-git-swap-'));
    const repo = join(root, 'repo');
    const first = join(root, 'first');
    const second = join(root, 'second');
    execFileSync('git', ['init', repo]);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Mitzo Test']);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
    execFileSync('git', [
      '-C',
      repo,
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-m',
      'initial',
    ]);
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-b', 'first', first]);
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-b', 'second', second]);
    await writeFile(join(first, '.git'), await readFile(join(second, '.git')));
    await writeFile(join(first, 'approved.txt'), 'approved');
    await expect(
      executeTrustedGitCommit(first, ['approved.txt'], 'blocked', new AbortController().signal),
    ).rejects.toThrow('registration does not match');
    expect(
      execFileSync('git', ['-C', second, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    ).toBe(execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  });

  it('rejects a symlinked object store before writing outside the repository', async () => {
    root = await mkdtemp(join(tmpdir(), 'mitzo-trusted-git-objects-'));
    const repo = join(root, 'repo');
    const worktree = join(root, 'worktree');
    const outside = join(root, 'outside-objects');
    execFileSync('git', ['init', repo]);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Mitzo Test']);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
    execFileSync('git', [
      '-C',
      repo,
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-m',
      'initial',
    ]);
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-b', 'objects', worktree]);
    await rename(join(repo, '.git/objects'), outside);
    await symlink(outside, join(repo, '.git/objects'));
    await writeFile(join(worktree, 'approved.txt'), 'approved');
    await expect(
      executeTrustedGitCommit(worktree, ['approved.txt'], 'blocked', new AbortController().signal),
    ).rejects.toThrow('object store must be a real directory');
  });

  it('rejects a symlinked object fanout before promoting quarantined objects', async () => {
    root = await mkdtemp(join(tmpdir(), 'mitzo-trusted-git-fanout-'));
    const repo = join(root, 'repo');
    const worktree = join(root, 'worktree');
    const outside = join(root, 'outside-fanout');
    const content = 'approved fanout content';
    execFileSync('git', ['init', repo]);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Mitzo Test']);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
    execFileSync('git', [
      '-C',
      repo,
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-m',
      'initial',
    ]);
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-b', 'fanout', worktree]);
    const object = execFileSync('git', ['hash-object', '--stdin'], {
      input: content,
      encoding: 'utf8',
    }).trim();
    await mkdir(outside);
    await symlink(outside, join(repo, '.git', 'objects', object.slice(0, 2)));
    await writeFile(join(worktree, 'approved.txt'), content);
    await expect(
      executeTrustedGitCommit(worktree, ['approved.txt'], 'blocked', new AbortController().signal),
    ).rejects.toThrow('object fanout must be a real directory');
    await expect(readFile(join(outside, object.slice(2)))).rejects.toThrow();
  });

  it('pins authenticated GitHub reads to github.com GET requests', () => {
    expect(trustedGitHubReadRequest('/user')).toEqual({
      file: 'gh',
      args: ['api', '--hostname', 'github.com', '--method', 'GET', '/user'],
    });
  });

  it('refuses credential-like files before staging them', async () => {
    root = await mkdtemp(join(tmpdir(), 'mitzo-trusted-git-'));
    execFileSync('git', ['init', root]);
    await writeFile(join(root, '.env'), 'SECRET=synthetic');
    await expect(
      executeTrustedGitCommit(root, ['.env'], 'unsafe', new AbortController().signal),
    ).rejects.toThrow('Credential-like');
    expect(execFileSync('git', ['-C', root, 'status', '--short'], { encoding: 'utf8' })).toContain(
      '?? .env',
    );
    expect(await readFile(join(root, '.env'), 'utf8')).toBe('SECRET=synthetic');
  });

  it('never recursively stages a directory passed directly to the trusted boundary', async () => {
    root = await mkdtemp(join(tmpdir(), 'mitzo-trusted-git-directory-'));
    const repo = join(root, 'repo');
    const worktree = join(root, 'worktree');
    execFileSync('git', ['init', repo]);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Mitzo Test']);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
    execFileSync('git', [
      '-C',
      repo,
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-m',
      'initial',
    ]);
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-b', 'directory', worktree]);
    await mkdir(join(worktree, 'changes'));
    await writeFile(join(worktree, 'changes/.env'), 'SECRET=synthetic');
    await expect(
      executeTrustedGitCommit(
        worktree,
        ['changes'],
        'unsafe recursive commit',
        new AbortController().signal,
      ),
    ).rejects.toThrow('regular files');
    expect(
      execFileSync('git', ['-C', worktree, 'status', '--short'], { encoding: 'utf8' }),
    ).toContain('?? changes/');
  });
});
