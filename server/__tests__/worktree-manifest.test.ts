import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { generateWorktreeManifest, writeWorktreeManifest } from '../worktree-manifest.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temporaryDirectories.push(directory);
  return directory;
}

function initializeRepository(): string {
  const repository = temporaryDirectory('mitzo-worktree-manifest-repo-');
  execFileSync('git', ['init', repository], { stdio: 'pipe' });
  execFileSync('git', ['-C', repository, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', repository, 'config', 'user.name', 'Test User']);
  writeFileSync(join(repository, 'tracked.txt'), 'base\n');
  execFileSync('git', ['-C', repository, 'add', 'tracked.txt']);
  execFileSync('git', ['-c', 'commit.gpgsign=false', '-C', repository, 'commit', '-m', 'initial']);
  return repository;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('generateWorktreeManifest', () => {
  it('records conservative evidence without refreshing linked-worktree Git metadata', () => {
    const repository = initializeRepository();
    const worktrees = join(repository, '.claude', 'worktrees');
    const sessionId = '2026-01-02-manifest';
    const worktree = join(worktrees, sessionId);
    mkdirSync(worktrees, { recursive: true });
    execFileSync(
      'git',
      ['-C', repository, 'worktree', 'add', '-b', `session/${sessionId}`, worktree],
      {
        stdio: 'pipe',
      },
    );
    writeFileSync(join(worktree, 'tracked.txt'), 'changed\n');
    writeFileSync(join(worktree, 'notes.md'), 'recover me\n');
    writeFileSync(join(worktree, '.mitzo-session'), '{}\n');
    const old = new Date('2026-01-03T00:00:00.000Z');
    utimesSync(worktree, old, old);

    const inbox = temporaryDirectory('mitzo-worktree-manifest-inbox-');
    writeFileSync(join(inbox, `20260104_worktree_gc_${sessionId}.md`), `**Path:** ${worktree}\n`);

    const indexPath = execFileSync(
      'git',
      ['-C', worktree, 'rev-parse', '--path-format=absolute', '--git-path', 'index'],
      { encoding: 'utf8' },
    ).trim();
    const indexBefore = readFileSync(indexPath);

    const manifest = generateWorktreeManifest({
      repositories: [repository],
      inboxDirectories: [inbox],
      activeSessionIds: new Set([sessionId]),
      now: new Date('2026-01-10T00:00:00.000Z'),
      pullRequests: [
        {
          repository,
          headRefName: `session/${sessionId}`,
          number: 42,
          url: 'https://example.test/pull/42',
          state: 'OPEN',
        },
      ],
    });

    expect(manifest).toMatchObject({ schemaVersion: 1, readOnly: true });
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0]).toMatchObject({
      sessionId,
      repository,
      path: worktree,
      registered: true,
      branch: `session/${sessionId}`,
      gitState: 'dirty',
      sessionSignals: { active: true, marker: true },
      proposedAction: 'preserve',
      protectionReasons: expect.arrayContaining(['active-session', 'uncommitted-work']),
      noticeIds: [`20260104_worktree_gc_${sessionId}.md`],
      reachability: {
        pullRequestLookup: 'complete',
        pullRequests: [{ number: 42, url: 'https://example.test/pull/42', state: 'OPEN' }],
      },
    });
    expect(manifest.entries[0].files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'tracked.txt', kinds: ['modified'] }),
        expect.objectContaining({ path: 'notes.md', kinds: ['untracked'] }),
      ]),
    );
    expect(manifest.entries[0].files.find((file) => file.path === 'notes.md')?.sha256).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(readFileSync(indexPath)).toEqual(indexBefore);
  });

  it('classifies metadata-less physical directories as unknown without walking the parent repo', () => {
    const repository = initializeRepository();
    const orphan = join(repository, '.claude', 'worktrees', 'orphan-directory');
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, 'evidence.txt'), 'orphan evidence\n');

    const manifest = generateWorktreeManifest({
      repositories: [repository],
      pullRequestLookupByRepository: new Map([[repository, 'unavailable']]),
    });

    expect(manifest.entries).toEqual([
      expect.objectContaining({
        sessionId: 'orphan-directory',
        registered: false,
        gitState: 'unknown',
        proposedAction: 'preserve',
        protectionReasons: expect.arrayContaining(['unregistered-directory']),
        reachability: expect.objectContaining({ pullRequestLookup: 'unavailable' }),
      }),
    ]);
  });

  it('includes and protects primary and external registered worktrees when requested', () => {
    const repository = initializeRepository();
    const externalRoot = temporaryDirectory('mitzo-worktree-manifest-external-');
    const external = join(externalRoot, 'feature-checkout');
    execFileSync('git', ['-C', repository, 'worktree', 'add', '-b', 'feature/external', external], {
      stdio: 'pipe',
    });

    const manifest = generateWorktreeManifest({
      repositories: [repository],
      includeRegisteredOutsideManagedRoots: true,
    });

    expect(manifest.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: repository,
          location: 'primary',
          proposedAction: 'preserve',
          protectionReasons: expect.arrayContaining(['primary-checkout']),
        }),
        expect.objectContaining({
          path: external,
          location: 'registered-external',
          branch: 'feature/external',
          proposedAction: 'preserve',
          protectionReasons: expect.arrayContaining(['outside-managed-root']),
        }),
      ]),
    );
  });
});

describe('writeWorktreeManifest', () => {
  it('writes an owner-only durable JSON artifact', () => {
    const outputDirectory = temporaryDirectory('mitzo-worktree-manifest-output-');
    chmodSync(outputDirectory, 0o700);
    const output = join(outputDirectory, 'manifest.json');
    const manifest = generateWorktreeManifest({ repositories: [] });

    writeWorktreeManifest(manifest, output);

    expect(existsSync(output)).toBe(true);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(manifest);
    expect(statSync(output).mode & 0o777).toBe(0o600);
  });
});
