import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeTrustedGitCommit } from '../trusted-native-operation.js';

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
});
