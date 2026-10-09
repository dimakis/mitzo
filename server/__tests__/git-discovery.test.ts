import express from 'express';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createGitInfoDiscovery, createGitInfoHandler } from '../git-discovery.js';

const record = (path: string, branch: string, extra = '') =>
  `worktree ${path}\0HEAD abc123\0${branch ? `branch refs/heads/${branch}` : 'detached'}\0${extra ? `${extra}\0` : ''}\0`;

function fixture() {
  const runGit = vi.fn(async (repo: string, args: string[]) => {
    if (args[0] === 'rev-parse') return 'main\n';
    return (
      record(repo, 'main') +
      Array.from({ length: 175 }, (_, i) =>
        record(`${repo}/.claude/worktrees/chat-${i}`, `session/chat-${i}`),
      ).join('') +
      record(`${repo}/.cursor/worktrees/space \n name`, '') +
      record('/unconfigured/external', 'external') +
      record(`${repo}-sessions/session-old`, 'legacy/session-old') +
      record(`${repo}/.claude/worktrees/stale`, 'stale', 'prunable missing')
    );
  });
  const discovery = createGitInfoDiscovery({ runGit });
  const app = express();
  app.get(
    '/api/git/info',
    createGitInfoHandler(discovery, () => ({
      repoPath: '/primary',
      repos: { secondary: '/secondary' },
    })),
  );
  return { app, runGit, discovery };
}

describe('lazy Git browser discovery', () => {
  it('returns root and branch without enumerating any worktree on default requests', async () => {
    const { app, runGit } = fixture();
    const result = await request(app).get('/api/git/info?root=/unconfigured');
    expect(result.body).toEqual({
      branch: 'main',
      repoPath: '/primary',
      worktrees: [],
      worktreesLoaded: false,
    });
    expect(runGit.mock.calls).toEqual([['/primary', ['rev-parse', '--abbrev-ref', 'HEAD']]]);
  });

  it('reads each configured repository once, preserves paths and refs, and caches discovery', async () => {
    const { app, runGit } = fixture();
    const result = await request(app).get('/api/git/info?worktrees=1&repo=/unconfigured');
    expect(result.body.worktreesLoaded).toBe(true);
    expect(result.body.worktrees).toHaveLength(354);
    expect(result.body.worktrees).toContainEqual({
      name: 'chat-174',
      path: '/secondary/.claude/worktrees/chat-174',
      branch: 'session/chat-174',
      age: 'unknown',
      repo: 'secondary',
    });
    expect(result.body.worktrees).toContainEqual({
      name: 'space \n name',
      path: '/primary/.cursor/worktrees/space \n name',
      branch: 'HEAD',
      age: 'unknown',
      repo: 'primary',
    });
    expect(result.body.worktrees).toContainEqual({
      name: 'session-old (legacy)',
      path: '/primary-sessions/session-old',
      branch: 'legacy/session-old',
      age: 'unknown',
      repo: 'primary',
    });
    expect(runGit).toHaveBeenCalledTimes(3);
    expect(runGit.mock.calls.slice(1)).toEqual([
      ['/primary', ['worktree', 'list', '--porcelain', '-z']],
      ['/secondary', ['worktree', 'list', '--porcelain', '-z']],
    ]);
    const cached = await request(app).get('/api/git/info?worktrees=1');
    expect(cached.body).toEqual(result.body);
    expect(runGit).toHaveBeenCalledTimes(3);
  });

  it('deduplicates concurrent requests and expires the cache', async () => {
    let now = 0;
    const runGit = vi.fn(async (repo: string, args: string[]) =>
      args[0] === 'rev-parse' ? 'main' : record(`${repo}/.claude/worktrees/chat`, 'chat'),
    );
    const discovery = createGitInfoDiscovery({ runGit, now: () => now, cacheTtlMs: 100 });
    await Promise.all(Array.from({ length: 8 }, () => discovery.getInfo('/repo', {}, true)));
    expect(runGit).toHaveBeenCalledTimes(2);
    now = 101;
    await discovery.getInfo('/repo', {}, true);
    expect(runGit).toHaveBeenCalledTimes(4);
    await discovery.getInfo('/other', {}, true);
    expect(runGit.mock.calls.at(-1)?.[0]).toBe('/other');
  });

  it('limits simultaneous Git processes across configured repos', async () => {
    let active = 0;
    let peak = 0;
    const runGit = vi.fn(async () => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return '';
    });
    const discovery = createGitInfoDiscovery({ runGit, concurrency: 3 });
    await discovery.getInfo(
      '/repo',
      Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`repo-${i}`, `/repo-${i}`])),
      true,
    );
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('keeps unavailable repos nonfatal and retries failed discovery', async () => {
    const runGit = vi
      .fn()
      .mockRejectedValueOnce(new Error('git unavailable'))
      .mockRejectedValueOnce(new Error('git unavailable'))
      .mockResolvedValue(record('/repo/.claude/worktrees/chat', 'chat'));
    const discovery = createGitInfoDiscovery({ runGit });
    expect(await discovery.getInfo('/repo', {}, true)).toEqual({
      branch: 'unknown',
      repoPath: '/repo',
      worktrees: [],
      worktreesLoaded: true,
    });
    await discovery.getInfo('/repo', {}, true);
    expect(runGit).toHaveBeenCalledTimes(4);
  });
});

it('reads native Git registration through a configured symlink without broadening roots', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mitzo-git-discovery-')));
  const repo = join(root, 'repo');
  const alias = join(root, 'configured-repo');
  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });
  try {
    git(['init', '-b', 'main', repo]);
    git([
      '-C',
      repo,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.test',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    ]);
    const path = join(repo, '.cursor', 'worktrees', 'space \n name');
    git(['-C', repo, 'worktree', 'add', '--detach', path]);
    git(['-C', repo, 'worktree', 'add', '-b', 'external', join(root, 'external')]);
    symlinkSync(repo, alias);
    const discovery = createGitInfoDiscovery();
    expect((await discovery.getInfo(alias, {}, true)).worktrees).toEqual([
      {
        path,
        name: 'space \n name',
        branch: 'HEAD',
        age: 'unknown',
        repo: 'primary',
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
