import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverLocalRepository, inspectLocalRepository } from '../local-repository-discovery.js';

let root: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-C', cwd, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
    {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    },
  ).trim();
async function repo(path: string) {
  await mkdir(path, { recursive: true });
  git(path, 'init', '-q', '-b', 'main');
  git(path, 'config', 'user.name', 'Offline Fixture');
  git(path, 'config', 'user.email', 'offline@example.invalid');
  await writeFile(join(path, 'source.txt'), 'original\n');
  git(path, 'add', '.');
  git(path, 'commit', '-qm', 'fixture');
  return path;
}
const scope = () => ({ kind: 'roots' as const, roots: [root] });
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-discovery-')));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('bounded repository discovery', () => {
  it('reports unsupported symbolic Git metadata as inspection unavailable instead of an absent repository', async () => {
    const selected = await repo(join(root, 'linked-storage'));
    const storage = join(root, 'storage');
    await rename(join(selected, '.git'), storage);
    await symlink(storage, join(selected, '.git'));
    expect(git(selected, 'rev-parse', '--show-toplevel')).toBe(selected);
    expect(
      await discoverLocalRepository({ query: 'linked-storage', accessScope: scope() }),
    ).toMatchObject({
      state: 'ambiguous',
      candidates: [],
      needed: [],
      diagnostics: [{ path: selected, reason: 'inspection-unavailable' }],
    });
  });
  it('finds two unrelated existing repositories without registry enrollment', async () => {
    const alpha = await repo(join(root, 'projects', 'alpha'));
    const beta = await repo(join(root, 'other', 'beta'));
    for (const [query, path] of [
      ['alpha', alpha],
      ['beta', beta],
    ]) {
      const result = await discoverLocalRepository({ query, accessScope: scope() });
      expect(result).toMatchObject({ state: 'selected', candidates: [{ path }], truncated: false });
    }
  });

  it('requires a choice for equal names even when orientation favors one', async () => {
    const first = await repo(join(root, 'one', 'service'));
    const second = await repo(join(root, 'two', 'service'));
    const result = await discoverLocalRepository({
      query: 'service',
      accessScope: scope(),
      orientationHints: [second],
    });
    expect(result.state).toBe('ambiguous');
    expect(result.candidates.map((candidate) => candidate.path).sort()).toEqual(
      [first, second].sort(),
    );
    expect(
      (
        await discoverLocalRepository({
          query: 'service',
          explicitPath: first,
          accessScope: scope(),
        })
      ).state,
    ).toBe('selected');
  });

  it('reports missing repository and the missing source/destination information', async () => {
    const result = await discoverLocalRepository({ query: 'absent', accessScope: scope() });
    expect(result).toMatchObject({
      state: 'missing',
      candidates: [],
      needed: ['source', 'destination'],
    });
  });

  it('accepts an explicit repository outside bounded discovery roots within read scope', async () => {
    const selected = await repo(join(root, 'unregistered', 'target'));
    await mkdir(join(root, 'orientation'));
    expect(
      await discoverLocalRepository({
        explicitPath: selected,
        accessScope: scope(),
        discoveryRoots: [join(root, 'orientation')],
      }),
    ).toMatchObject({ state: 'selected', candidates: [{ path: selected }] });
  });

  it('canonicalizes explicit paths and refuses symlink escapes from authorized access', async () => {
    const selected = await repo(join(root, 'authorized', 'target'));
    await symlink(selected, join(root, 'alias'));
    expect(
      await discoverLocalRepository({ explicitPath: join(root, 'alias'), accessScope: scope() }),
    ).toMatchObject({ state: 'selected', candidates: [{ path: selected }] });
    const limited = { kind: 'roots' as const, roots: [join(root, 'authorized')] };
    await symlink(root, join(root, 'authorized', 'escape'));
    expect(
      (
        await discoverLocalRepository({
          explicitPath: join(root, 'authorized', 'escape'),
          accessScope: limited,
        })
      ).state,
    ).toBe('access-required');
  });

  it('does not traverse credentials, git internals, dependencies or symlink loops', async () => {
    await repo(join(root, '.ssh', 'secret'));
    await repo(join(root, 'node_modules', 'dependency'));
    await repo(join(root, 'ordinary', '.git', 'internal'));
    await symlink(root, join(root, 'loop'));
    const result = await discoverLocalRepository({ query: 'secret', accessScope: scope() });
    expect(result.candidates).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(
      (
        await discoverLocalRepository({
          explicitPath: join(root, '.ssh', 'secret'),
          accessScope: scope(),
        })
      ).state,
    ).toBe('access-required');
  });

  it('reports bounded incomplete search instead of silently selecting the first match', async () => {
    await repo(join(root, 'one', 'service'));
    await repo(join(root, 'two', 'service'));
    const result = await discoverLocalRepository({
      query: 'service',
      accessScope: scope(),
      limits: { maxCandidates: 1 },
    });
    expect(result).toMatchObject({ state: 'ambiguous', truncated: true });
    expect(result.limitReasons).toContain('candidates');
  });

  it('requires bounded roots for host-wide access and honors cancellation', async () => {
    expect(
      await discoverLocalRepository({ query: 'service', accessScope: { kind: 'host-wide' } }),
    ).toMatchObject({ state: 'access-required', needed: ['discovery-roots'] });
    expect(
      await discoverLocalRepository({
        query: 'service',
        accessScope: { kind: 'host-wide' },
        discoveryRoots: ['/'],
      }),
    ).toMatchObject({ state: 'access-required' });
    const controller = new AbortController();
    controller.abort();
    await expect(
      discoverLocalRepository({
        query: 'service',
        accessScope: scope(),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('skips generic configuration directories during scans but accepts explicit accessible repositories inside them', async () => {
    const selected = await repo(join(root, '.config', 'editor'));
    expect(await discoverLocalRepository({ query: 'editor', accessScope: scope() })).toMatchObject({
      state: 'missing',
      candidates: [],
    });
    expect(
      await discoverLocalRepository({ explicitPath: selected, accessScope: scope() }),
    ).toMatchObject({ state: 'selected', candidates: [{ path: selected }] });
  });

  it('reports existing repositories with bounded metadata inspection as incomplete instead of absent or unauthorized', async () => {
    const selected = await repo(join(root, 'large'));
    for (const selection of [{ query: 'large' }, { explicitPath: selected }]) {
      const result = await discoverLocalRepository({
        ...selection,
        accessScope: scope(),
        limits: { maxGitMetadataEntries: 1 },
      });
      expect(result).toMatchObject({
        state: 'ambiguous',
        truncated: true,
        needed: ['narrower-search'],
      });
      expect(result.limitReasons).toContain('git-metadata-entries');
    }
  });
});

describe('read-only repository inspection', () => {
  it('preserves staged, unstaged and untracked work and reads applicable parent/repository/scoped instructions', async () => {
    const selected = await repo(join(root, 'projects', 'alpha'));
    await mkdir(join(selected, 'src'));
    await writeFile(join(root, 'AGENTS.md'), 'parent instruction');
    await writeFile(join(selected, 'CLAUDE.md'), 'repository instruction');
    await writeFile(join(selected, 'src', 'AGENTS.md'), 'scoped instruction');
    await writeFile(join(selected, 'source.txt'), 'staged\n');
    git(selected, 'add', 'source.txt');
    await writeFile(join(selected, 'source.txt'), 'unstaged\n');
    await writeFile(join(selected, 'untracked.txt'), 'preserve this');
    const status = git(selected, 'status', '--porcelain');
    const result = await inspectLocalRepository({
      path: join(selected, 'src'),
      accessScope: scope(),
    });
    expect(result).toMatchObject({
      path: selected,
      cwd: join(selected, 'src'),
      branch: 'main',
      dirty: { state: 'dirty' },
    });
    expect(result.dirty.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'source.txt', index: 'M', worktree: 'M' }),
        expect.objectContaining({ path: 'untracked.txt', index: '?', worktree: '?' }),
      ]),
    );
    expect(result.instructions.files.map((file) => file.content)).toEqual([
      'parent instruction',
      'repository instruction',
      'scoped instruction',
    ]);
    expect(result.instructions.complete).toBe(false); // Above-root ancestors are not authorized.
    expect(result.instructions.omitted.some((item) => item.reason === 'outside-access')).toBe(true);
    expect(git(selected, 'status', '--porcelain')).toBe(status);
    expect(await readFile(join(selected, 'source.txt'), 'utf8')).toBe('unstaged\n');
  });

  it('inspects linked worktrees with common ownership facts without claiming another session', async () => {
    const selected = await repo(join(root, 'alpha'));
    const worktree = join(root, 'task');
    git(selected, 'worktree', 'add', '-qb', 'session/other', worktree);
    const original = await inspectLocalRepository({ path: selected, accessScope: scope() });
    const linked = await inspectLocalRepository({ path: worktree, accessScope: scope() });
    expect(linked.commonDirectory).toBe(original.commonDirectory);
    expect(linked.gitDirectory).not.toBe(linked.commonDirectory);
    expect(linked.worktrees).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: worktree, branch: 'refs/heads/session/other' }),
      ]),
    );
    expect(linked.branch).toBe('session/other');
  });

  it('bounds instruction reads and does not follow instruction symlinks to credential material', async () => {
    const selected = await repo(join(root, 'alpha'));
    await writeFile(join(selected, 'AGENTS.md'), 'x'.repeat(100));
    await mkdir(join(root, '.ssh'));
    await writeFile(join(root, '.ssh', 'token'), 'must not expose');
    await symlink(join(root, '.ssh', 'token'), join(selected, 'CLAUDE.md'));
    const result = await inspectLocalRepository({
      path: selected,
      accessScope: scope(),
      limits: { maxInstructionBytes: 10 },
    });
    expect(result.instructions.complete).toBe(false);
    expect(result.instructions.files[0]).toMatchObject({ content: 'xxxxxxxxxx', truncated: true });
    expect(result.instructions.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: join(selected, 'CLAUDE.md'), reason: 'symlink' }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain('must not expose');
  });

  it('reads authorized instruction symlinks with canonical identity and omits unauthorized shared targets', async () => {
    const selected = await repo(join(root, 'source'));
    const agents = join(selected, 'AGENTS.md');
    const claude = join(selected, 'CLAUDE.md');
    await writeFile(agents, 'shared repository guidance');
    await symlink('AGENTS.md', claude);
    const sameRepository = await inspectLocalRepository({ path: selected, accessScope: scope() });
    expect(sameRepository.instructions.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: claude,
          resolvedPath: agents,
          content: 'shared repository guidance',
          identity: { dev: expect.any(Number), ino: expect.any(Number) },
        }),
      ]),
    );
    await rm(claude);
    const shared = join(root, 'shared.md');
    await writeFile(shared, 'authorized shared guidance');
    await symlink(shared, claude);
    expect(
      (await inspectLocalRepository({ path: selected, accessScope: scope() })).instructions.files,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: claude,
          resolvedPath: shared,
          content: 'authorized shared guidance',
        }),
      ]),
    );
    const limited = await inspectLocalRepository({
      path: selected,
      accessScope: { kind: 'roots', roots: [selected] },
    });
    expect(limited.instructions.files.some((file) => file.path === claude)).toBe(false);
    expect(limited.instructions.omitted).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: claude, reason: 'symlink' })]),
    );
  });

  it('does not execute clean filters or recurse into configured submodules while checking dirty work', async () => {
    const selected = await repo(join(root, 'filtered'));
    const marker = join(root, 'executed');
    const nested = await repo(join(selected, 'nested'));
    git(
      selected,
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${git(nested, 'rev-parse', 'HEAD')},nested`,
    );
    git(nested, 'config', 'core.fsmonitor', `touch '${marker}'`);
    git(selected, 'config', 'filter.danger.clean', `touch '${marker}'; cat`);
    git(selected, 'config', 'filter.danger.required', 'true');
    await writeFile(join(selected, '.gitattributes'), 'source.txt filter=danger\n');
    await writeFile(
      join(selected, '.gitmodules'),
      '[submodule "escape"]\npath = nested\nurl = /outside\n',
    );
    git(selected, 'config', 'submodule.escape.update', `!touch '${marker}'`);
    await writeFile(join(selected, 'source.txt'), 'modified\n');
    const result = await inspectLocalRepository({ path: selected, accessScope: scope() });
    expect(await readFile(marker, 'utf8').catch(() => null)).toBeNull();
    expect(result.dirty).toMatchObject({
      state: 'dirty',
      entries: expect.arrayContaining([expect.objectContaining({ path: 'source.txt' })]),
    });
  });

  it('rejects include configuration before Git can read its target', async () => {
    const selected = await repo(join(root, 'included'));
    await mkdir(join(root, '.ssh'));
    await writeFile(join(root, '.ssh', 'private'), '[filter "danger"]\nclean = false\n');
    git(selected, 'config', 'include.path', join(root, '.ssh', 'private'));
    await expect(inspectLocalRepository({ path: selected, accessScope: scope() })).rejects.toThrow(
      /include|configuration/i,
    );
    expect(
      await discoverLocalRepository({ explicitPath: selected, accessScope: scope() }),
    ).toMatchObject({ state: 'ambiguous', diagnostics: [{ reason: 'inspection-unavailable' }] });
  });

  it('rejects linked, symlinked and common Git directories outside the current read scope', async () => {
    const selected = await repo(join(root, 'source'));
    const worktree = join(root, 'limited', 'task');
    await mkdir(join(root, 'limited'));
    git(selected, 'worktree', 'add', '-qb', 'session/limited', worktree);
    const limited = { kind: 'roots' as const, roots: [join(root, 'limited')] };
    await expect(inspectLocalRepository({ path: worktree, accessScope: limited })).rejects.toThrow(
      /access|metadata/i,
    );
    expect(
      (await discoverLocalRepository({ explicitPath: worktree, accessScope: limited })).state,
    ).toBe('access-required');
    const linked = join(root, 'limited', 'linked');
    await mkdir(linked);
    await symlink(join(selected, '.git'), join(linked, '.git'));
    await expect(inspectLocalRepository({ path: linked, accessScope: limited })).rejects.toThrow(
      /symlink|metadata/i,
    );
    const indirect = join(root, 'limited', 'indirect');
    git(selected, 'worktree', 'add', '-qb', 'session/indirect', indirect);
    // Its worktree metadata is inside the limited scope; commondir remains outside.
    const ownedMetadata = join(root, 'limited', 'metadata');
    await mkdir(ownedMetadata);
    await writeFile(join(ownedMetadata, 'HEAD'), 'ref: refs/heads/session/indirect\n');
    await writeFile(join(ownedMetadata, 'commondir'), join(selected, '.git') + '\n');
    await writeFile(join(indirect, '.git'), `gitdir: ${ownedMetadata}\n`);
    await expect(inspectLocalRepository({ path: indirect, accessScope: limited })).rejects.toThrow(
      /access|metadata/i,
    );
  });

  it('allows explicit managed worktrees without scanning agent credential directories', async () => {
    const selected = await repo(join(root, 'source'));
    const worktree = join(selected, '.claude', 'worktrees', 'owned');
    git(selected, 'worktree', 'add', '-qb', 'session/owned', worktree);
    expect(
      await discoverLocalRepository({ explicitPath: worktree, accessScope: scope() }),
    ).toMatchObject({ state: 'selected', candidates: [{ path: worktree }] });
    expect(await inspectLocalRepository({ path: worktree, accessScope: scope() })).toMatchObject({
      path: worktree,
      branch: 'session/owned',
    });
  });

  it('rejects credential Git pointers, alternate object stores and symlink metadata', async () => {
    const selected = await repo(join(root, 'source'));
    const pointed = join(root, 'pointed');
    await mkdir(pointed);
    await writeFile(join(pointed, '.git'), `gitdir: ${join(root, '.ssh', 'private')}\n`);
    expect(
      (await discoverLocalRepository({ explicitPath: pointed, accessScope: scope() })).state,
    ).toBe('access-required');
    await writeFile(
      join(selected, '.git', 'objects', 'info', 'alternates'),
      join(root, '.ssh', 'private') + '\n',
    );
    await expect(inspectLocalRepository({ path: selected, accessScope: scope() })).rejects.toThrow(
      /alternate/i,
    );
    await rm(join(selected, '.git', 'objects', 'info', 'alternates'));
    await symlink(join(root, '.ssh', 'private'), join(selected, '.git', 'refs', 'unsafe'));
    await expect(inspectLocalRepository({ path: selected, accessScope: scope() })).rejects.toThrow(
      /symlink/i,
    );
  });
});
