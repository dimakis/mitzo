import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  appendFile,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { mkdirSync, renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inspectLocalRepository as inspectRepository,
  discoverLocalRepository as discoverRepository,
} from '../local-repository-discovery.js';

const linkRace = vi.hoisted(() => ({
  run: undefined as (() => void) | undefined,
  noStat: false,
  beforeList: undefined as ((path: string) => void) | undefined,
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const patch = (child: ReturnType<typeof actual.execFile>) => {
    if (child.stdin) {
      const end = child.stdin.end.bind(child.stdin);
      child.stdin.end = ((chunk: string) => {
        if (typeof chunk === 'string' && chunk.includes('"operation":"ListDirectory"'))
          linkRace.beforeList?.((JSON.parse(chunk) as { file_path: string }).file_path);
        if (typeof chunk === 'string' && chunk.includes('"operation":"ReadLink"')) {
          const run = linkRace.run;
          linkRace.run = undefined;
          run?.();
        }
        return end(chunk);
      }) as typeof child.stdin.end;
    }
    return child;
  };
  const instrument = (args: Parameters<typeof actual.execFile>) => {
    if (linkRace.noStat && Array.isArray(args[1]))
      args[1] = args[1].map((value) =>
        value.replace(
          'child = entry.stat(follow_symlinks=False)',
          "if entry.name.startswith('PRIVATE-DENIED') or entry.name == '.aws': raise RuntimeError('Forbidden metadata probe')\n                    child = entry.stat(follow_symlinks=False)",
        ),
      );
    return args;
  };
  const wrapped = (...args: Parameters<typeof actual.execFile>) =>
    patch(actual.execFile(...instrument(args)));
  const originalPromise = promisify(actual.execFile);
  Object.defineProperty(wrapped, promisify.custom, {
    value: (...args: Parameters<typeof originalPromise>) => {
      const result = originalPromise(...args);
      patch(result.child);
      return result;
    },
  });
  return { ...actual, execFile: wrapped };
});

import {
  fixtureReadAnchor,
  fixtureReadExclusions,
} from './fixtures/local-repository-read-owner.js';
const inspectLocalRepository = (request: Parameters<typeof inspectRepository>[0]) =>
  inspectRepository({
    captureReadAnchor: fixtureReadAnchor,
    captureReadExclusions: fixtureReadExclusions,
    ...request,
  });

// Descriptor-relative fixture I/O launches the isolated existing Python helper.
vi.setConfig({ testTimeout: 30000 });

let root: string;
let selected: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-read-security-')));
  selected = join(root, 'repository');
  await mkdir(selected);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', selected, '-c', 'commit.gpgsign=false', ...args], {
      env: {
        PATH: '/usr/bin:/bin',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    });
  git('init', '-q', '-b', 'fixture-private-branch');
  git('config', 'user.name', 'Offline Fixture');
  git('config', 'user.email', 'offline@example.invalid');
  await writeFile(join(selected, 'source.txt'), 'source\n');
  git('add', '.');
  git('commit', '-qm', 'fixture');
});
afterEach(async () => {
  linkRace.run = undefined;
  linkRace.noStat = false;
  linkRace.beforeList = undefined;
  await rm(root, { recursive: true, force: true });
});

it('refuses denied regular HEAD metadata before exposing branch or object facts', async () => {
  const denied = join(selected, '.git', 'HEAD');
  await expect(
    inspectLocalRepository({
      path: selected,
      accessScope: { kind: 'roots', roots: [root], deniedRoots: [denied] },
      assertReadAccess: async (path) => {
        if (path === denied) throw Error('HEAD access denied');
      },
    }),
  ).rejects.toMatchObject({ kind: 'access', reason: 'read-access-required' });
});

it('never lets Git follow source config includes introduced after metadata qualification', async () => {
  const denied = join(root, 'denied');
  await mkdir(denied);
  const sentinel = join(denied, 'invalid-review-fixture.config');
  await writeFile(sentinel, 'INVALID REVIEW FIXTURE CONFIG\n');
  let configQualified = false;
  let mutated = false;
  let deniedChecked = false;
  let outcome: unknown;
  try {
    outcome = await inspectLocalRepository({
      path: selected,
      accessScope: { kind: 'roots', roots: [root], deniedRoots: [denied] },
      assertReadAccess: async (path) => {
        if (path === join(selected, '.git', 'config')) configQualified = true;
        if (path.startsWith(denied)) {
          deniedChecked = true;
          throw Error('sentinel access denied');
        }
        if (configQualified && !mutated && path === selected) {
          mutated = true;
          await appendFile(join(selected, '.git', 'config'), `\n[include]\npath=${sentinel}\n`);
        }
      },
    });
  } catch (error) {
    outcome = error;
  }
  expect(mutated).toBe(true);
  expect(deniedChecked).toBe(false);
  // A conservative refusal is safe; an unclassified subprocess failure proving
  // Git parsed the denied sentinel is not. No production/credential paths exist.
  if (outcome instanceof Error) {
    expect(outcome).toMatchObject({ kind: expect.stringMatching(/^(unsafe|access|limit)$/) });
    expect(outcome.message).not.toContain(sentinel);
  } else {
    expect(outcome).toMatchObject({ path: selected, branch: 'fixture-private-branch' });
  }
});

for (const relativePath of ['.git/index', '.git/refs/heads/fixture-private-branch', 'source.txt']) {
  it(`checks current owner authority for consumed regular ${relativePath}`, async () => {
    const denied = join(selected, relativePath);
    let checked = false;
    let outcome: unknown;
    try {
      outcome = await inspectLocalRepository({
        path: selected,
        accessScope: { kind: 'roots', roots: [root] },
        assertReadAccess: async (path) => {
          if (path === denied) {
            checked = true;
            throw Error('fixture current read denied');
          }
        },
      });
    } catch (error) {
      outcome = error;
    }
    expect(checked, outcome instanceof Error ? outcome.message : JSON.stringify(outcome)).toBe(
      true,
    );
    if (outcome instanceof Error) {
      expect(outcome).toMatchObject({ kind: 'access', reason: 'read-access-required' });
    } else {
      expect(outcome).toMatchObject({ dirty: { state: 'unknown', entries: [] } });
    }
  });
}

it('reports an accessible bare repository as unsupported existing storage rather than absent source', async () => {
  const bare = join(root, 'bare-target');
  await mkdir(bare);
  execFileSync('git', ['init', '--bare', '--quiet', bare], {
    env: { PATH: '/usr/bin:/bin', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  const { discoverLocalRepository } = await import('../local-repository-discovery.js');
  const result = await discoverLocalRepository({
    query: 'bare-target',
    discoveryRoots: [root],
    accessScope: { kind: 'roots', roots: [root] },
    captureReadAnchor: fixtureReadAnchor,
    captureReadExclusions: fixtureReadExclusions,
  });
  expect(result.state).toBe('ambiguous');
  expect(result.needed).not.toContain('source');
  expect(result.diagnostics).toContainEqual({ path: bare, reason: 'bare-repository-unsupported' });
});

it('discovers authorized instruction file aliases through the anchored reader', async () => {
  await writeFile(join(selected, 'guidance.md'), 'authorized alias guidance');
  await symlink('guidance.md', join(selected, 'CLAUDE.md'));
  const result = await inspectLocalRepository({
    path: selected,
    accessScope: { kind: 'roots', roots: [root] },
  });
  expect(result.dirty.state).toBe('unknown');
  expect(result.instructions.files).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: join(selected, 'CLAUDE.md'),
        resolvedPath: join(selected, 'guidance.md'),
        content: 'authorized alias guidance',
      }),
    ]),
  );
});
it('omits a denied instruction target without exposing its path or contents', async () => {
  const denied = join(root, 'PRIVATE-TARGET');
  await mkdir(denied);
  await writeFile(join(denied, 'rules'), 'PRIVATE-CONTENT');
  await symlink(join(denied, 'rules'), join(selected, 'CLAUDE.md'));
  const result = await inspectLocalRepository({
    path: selected,
    accessScope: { kind: 'roots', roots: [selected] },
  });
  expect(result.instructions.files).toEqual([]);
  expect(result.instructions.omitted).toContainEqual({
    path: join(selected, 'CLAUDE.md'),
    reason: 'symlink',
  });
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE-TARGET|PRIVATE-CONTENT/);
});
it.each(['link', 'parent', 'root'] as const)(
  'refuses an instruction %s swapped at readlinkat without exposing target bytes',
  async (kind) => {
    await writeFile(join(selected, 'guidance.md'), 'ORIGINAL-RULES');
    await symlink('guidance.md', join(selected, 'CLAUDE.md'));
    const denied = join(root, 'PRIVATE-TARGET');
    await mkdir(denied);
    await writeFile(join(denied, 'guidance.md'), 'PRIVATE-CONTENT');
    await symlink('guidance.md', join(denied, 'CLAUDE.md'));
    linkRace.run = () => {
      if (kind === 'link') {
        renameSync(join(selected, 'CLAUDE.md'), join(selected, 'old-link'));
        symlinkSync(join(denied, 'guidance.md'), join(selected, 'CLAUDE.md'));
      } else {
        renameSync(selected, join(root, 'moved-source'));
        if (kind === 'parent') symlinkSync(denied, selected);
        else renameSync(denied, selected);
      }
    };
    let projection: unknown;
    try {
      projection = await inspectLocalRepository({
        path: selected,
        accessScope: { kind: 'roots', roots: [root] },
      });
    } catch (error) {
      projection = { reason: (error as { reason?: string }).reason };
    }
    expect(linkRace.run).toBeUndefined();
    expect(JSON.stringify(projection)).not.toMatch(/PRIVATE-TARGET|PRIVATE-CONTENT|ORIGINAL-RULES/);
  },
);
it('bounds instruction alias loops without exposing targets', async () => {
  await symlink('CLAUDE.md', join(selected, 'AGENTS.md'));
  await symlink('AGENTS.md', join(selected, 'CLAUDE.md'));
  const loop = await inspectLocalRepository({
    path: selected,
    accessScope: { kind: 'roots', roots: [root] },
  });
  expect(loop.instructions.files).toEqual([]);
  expect(loop.instructions.omitted.filter((value) => value.reason === 'symlink')).toHaveLength(2);
});
it('bounds oversized instruction alias chains without exposing targets', async () => {
  await symlink('alias0', join(selected, 'CLAUDE.md'));
  for (let i = 0; i < 17; i++) await symlink('alias' + (i + 1), join(selected, 'alias' + i));
  await writeFile(join(selected, 'alias17'), 'OVERSIZED-CHAIN-CONTENT');
  const bounded = await inspectLocalRepository({
    path: selected,
    accessScope: { kind: 'roots', roots: [root] },
  });
  expect(bounded.instructions.files).toEqual([]);
  expect(bounded.instructions.omitted).toContainEqual({
    path: join(selected, 'CLAUDE.md'),
    reason: 'symlink',
  });
  expect(JSON.stringify(bounded)).not.toContain('OVERSIZED-CHAIN-CONTENT');
});
it('cancels instruction alias resolution before exposing any resolved bytes', async () => {
  await symlink('source.txt', join(selected, 'CLAUDE.md'));
  const controller = new AbortController();
  linkRace.run = () => controller.abort();
  await expect(
    inspectLocalRepository({
      path: selected,
      accessScope: { kind: 'roots', roots: [root] },
      signal: controller.signal,
    }),
  ).rejects.toThrow();
  expect(linkRace.run).toBeUndefined();
});

it('unions actual owner exclusions with additional restrictions before metadata and reports unknown without names or counts', async () => {
  const actual = join(selected, 'PRIVATE-DENIED-ACTUAL');
  const restrictive = join(selected, 'PRIVATE-DENIED-RESTRICTIVE');
  await writeFile(actual, 'PRIVATE-CONTENT-ACTUAL');
  await writeFile(restrictive, 'PRIVATE-CONTENT-RESTRICTIVE');
  linkRace.noStat = true;
  const result = await inspectLocalRepository({
    path: selected,
    accessScope: { kind: 'roots', roots: [root], deniedRoots: [restrictive] },
    captureReadExclusions: async () => Object.freeze([actual]),
  });
  expect(result.dirty).toEqual({ state: 'unknown', entries: [] });
  expect(result.diagnostics).toContainEqual({ path: selected, reason: 'read-scope-incomplete' });
  expect(result.instructions.complete).toBe(false);
  expect(JSON.stringify(result)).not.toMatch(
    /PRIVATE-DENIED|PRIVATE-CONTENT|excludedCount|deniedCount/,
  );
});
it('withholds all source reads without a valid complete actual exclusion projection', async () => {
  await expect(
    inspectLocalRepository({
      path: selected,
      accessScope: { kind: 'roots', roots: [root] },
      captureReadExclusions: undefined,
    }),
  ).rejects.toMatchObject({ kind: 'access', reason: 'read-exclusions-required' });
  await expect(
    inspectLocalRepository({
      path: selected,
      accessScope: { kind: 'roots', roots: [root] },
      captureReadExclusions: async () => Array(257).fill(root),
    }),
  ).rejects.toMatchObject({ kind: 'access', reason: 'read-exclusions-required' });
});

it.each([false, true])(
  'supports a valid Unicode branch in loose or packed references (%s)',
  async (packed) => {
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', selected, ...args], {
        env: {
          PATH: '/usr/bin:/bin',
          GIT_CONFIG_SYSTEM: '/dev/null',
          GIT_CONFIG_GLOBAL: '/dev/null',
        },
      });
    git('branch', '-m', 'feature/β');
    if (packed) git('pack-refs', '--all');
    const result = await inspectLocalRepository({
      path: selected,
      accessScope: { kind: 'roots', roots: [root] },
    });
    expect(result.branch).toBe('feature/β');
    expect(result.head).toMatch(/^[a-f0-9]{40}$/);
    expect(result.dirty).toEqual({ state: 'clean', entries: [] });
  },
);
it('reports unknown when separately anchored external Git metadata has omitted denied children', async () => {
  const storage = join(root, 'external-storage');
  await rename(join(selected, '.git'), storage);
  await writeFile(join(selected, '.git'), 'gitdir: ' + storage + '\n');
  const denied = join(storage, 'PRIVATE-DENIED-METADATA');
  await writeFile(denied, 'PRIVATE-CONTENT');
  linkRace.noStat = true;
  const result = await inspectLocalRepository({
    path: selected,
    accessScope: { kind: 'roots', roots: [root] },
    captureReadExclusions: async () => Object.freeze([denied]),
  });
  expect(result.dirty).toEqual({ state: 'unknown', entries: [] });
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE-DENIED|PRIVATE-CONTENT/);
});

it('keeps applicable instruction files complete when an unrelated denied sibling is pruned', async () => {
  const denied = join(root, 'PRIVATE-DENIED-SIBLING');
  await mkdir(denied);
  await writeFile(join(denied, 'private'), 'PRIVATE-CONTENT');
  await writeFile(join(root, 'AGENTS.md'), 'parent fixture instructions');
  await writeFile(join(selected, 'CLAUDE.md'), 'repository fixture instructions');
  linkRace.noStat = true;
  const result = await inspectLocalRepository({
    path: selected,
    accessScope: { kind: 'roots', roots: [root] },
    captureReadExclusions: async () => Object.freeze([denied]),
  });
  expect(result.dirty).toEqual({
    state: 'dirty',
    entries: [{ path: 'CLAUDE.md', index: '?', worktree: '?' }],
  });
  expect(result.instructions.files.map((value) => value.content)).toEqual([
    'parent fixture instructions',
    'repository fixture instructions',
  ]);
  expect(
    result.instructions.omitted.some((value) => value.reason === 'read-scope-incomplete'),
  ).toBe(false);
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE-DENIED|PRIVATE-CONTENT/);
});

it('classifies a source exclusion first observed during final verification as unknown', async () => {
  let lists = 0;
  let injected = false;
  linkRace.noStat = true;
  linkRace.beforeList = (path) => {
    if (path === selected && ++lists === 2) {
      mkdirSync(join(selected, '.aws'));
      injected = true;
    }
  };
  const result = await inspectLocalRepository({
    path: selected,
    accessScope: { kind: 'roots', roots: [selected] },
  });
  expect(injected).toBe(true);
  expect(result.dirty).toEqual({ state: 'unknown', entries: [] });
  expect(result.diagnostics).toContainEqual({ path: selected, reason: 'read-scope-incomplete' });
  expect(JSON.stringify(result)).not.toContain('.aws');
});
it('retains a unique eligible discovery and reports restriction first observed during final verification', async () => {
  let lists = 0;
  let injected = false;
  linkRace.noStat = true;
  linkRace.beforeList = (path) => {
    if (path === root && ++lists === 2) {
      mkdirSync(join(root, '.aws'));
      injected = true;
    }
  };
  const result = await discoverRepository({
    query: 'repository',
    accessScope: { kind: 'roots', roots: [root] },
    captureReadAnchor: fixtureReadAnchor,
    captureReadExclusions: fixtureReadExclusions,
  });
  expect(injected).toBe(true);
  expect(result).toMatchObject({
    state: 'selected',
    candidates: [{ path: selected }],
    restricted: true,
    truncated: false,
  });
  expect(JSON.stringify(result)).not.toContain('.aws');
});
