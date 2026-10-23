import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectLocalRepository } from '../local-repository-discovery.js';
import { LocalRepositoryReadAccess } from '../local-repository-read-access.js';
import {
  fixtureReadAnchor,
  fixtureReadExclusions,
} from './fixtures/local-repository-read-owner.js';

vi.setConfig({ testTimeout: 30000 });
let root: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-worktree-facts-')));
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-C', root!, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
      {
        encoding: 'utf8',
        env: {
          PATH: '/usr/bin:/bin',
          HOME: '/nonexistent',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
        },
      },
    ).trim();
  git('init', '--template=', '-q', '-b', 'fixture-current');
  git('config', 'user.name', 'Offline Fixture');
  git('config', 'user.email', 'offline@example.invalid');
  await writeFile(join(root, 'source.txt'), 'original\n');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  const path = root;
  const inspect = (deniedRoots: string[] = []) =>
    inspectLocalRepository({
      path,
      accessScope: { kind: 'roots', roots: [path], deniedRoots },
      captureReadAnchor: fixtureReadAnchor,
      captureReadExclusions: async () =>
        Object.freeze([...(await fixtureReadExclusions()), ...deniedRoots]),
      limits: { timeoutMs: 30000 },
    });
  return { path, git, inspect };
}

it('retains the ordinary repository current worktree when its registry is definitively absent', async () => {
  const f = await fixture();
  expect(f.git('worktree', 'list', '--porcelain')).toContain(`worktree ${f.path}`);
  const result = await f.inspect();
  expect(result.worktrees).toEqual([
    {
      path: f.path,
      head: f.git('rev-parse', 'HEAD'),
      branch: 'refs/heads/fixture-current',
      locked: false,
    },
  ]);
  expect(result.diagnostics).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ reason: 'worktrees-unavailable' })]),
  );
});

it.each(['denied', 'file'] as const)(
  'does not reinterpret a %s registry as definite absence',
  async (kind) => {
    const f = await fixture();
    const registry = join(f.path, '.git', 'worktrees');
    if (kind === 'file') await writeFile(registry, 'unsupported registry\n');
    else await mkdir(registry);
    const result = await f.inspect(kind === 'denied' ? [registry] : []);
    expect(result.worktrees).toEqual([]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: 'worktrees-unavailable' })]),
    );
  },
);

it('invalidates a registry first created after authorized definite-absence observation', async () => {
  const f = await fixture();
  const registry = join(f.path, '.git', 'worktrees');
  const original = LocalRepositoryReadAccess.prototype.stat;
  let injected = false;
  vi.spyOn(LocalRepositoryReadAccess.prototype, 'stat').mockImplementation(async function (
    this: LocalRepositoryReadAccess,
    path: string,
  ) {
    const entry = await original.call(this, path);
    if (!injected && path === registry && entry === undefined) {
      injected = true;
      await mkdir(registry);
    }
    return entry;
  });
  await expect(f.inspect()).rejects.toMatchObject({ kind: 'unsafe' });
  expect(injected).toBe(true);
});
