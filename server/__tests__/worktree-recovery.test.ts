import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { generateWorktreeManifest } from '../worktree-manifest.js';
import { createWorktreeRecoveryPackage, rehearseWorktreeRecovery } from '../worktree-recovery.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temporaryDirectories.push(directory);
  return directory;
}

function commit(repository: string, message: string): void {
  execFileSync('git', ['-c', 'commit.gpgsign=false', '-C', repository, 'commit', '-m', message]);
}

function fixture(): { repository: string; worktree: string; sessionId: string } {
  const repository = temporaryDirectory('mitzo-worktree-recovery-repo-');
  execFileSync('git', ['init', repository], { stdio: 'pipe' });
  execFileSync('git', ['-C', repository, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', repository, 'config', 'user.name', 'Test User']);
  writeFileSync(join(repository, 'staged.txt'), 'base staged\n');
  writeFileSync(join(repository, 'unstaged.txt'), 'base unstaged\n');
  execFileSync('git', ['-C', repository, 'add', '.']);
  commit(repository, 'initial');

  const sessionId = 'recovery-fixture';
  const worktree = join(repository, '.claude', 'worktrees', sessionId);
  execFileSync(
    'git',
    ['-C', repository, 'worktree', 'add', '-b', `session/${sessionId}`, worktree],
    {
      stdio: 'pipe',
    },
  );
  writeFileSync(join(worktree, 'staged.txt'), 'staged recovery\n');
  execFileSync('git', ['-C', worktree, 'add', 'staged.txt']);
  writeFileSync(join(worktree, 'unstaged.txt'), 'unstaged recovery\n');
  writeFileSync(join(worktree, 'notes.md'), 'selected untracked evidence\n');
  writeFileSync(join(worktree, '.env'), 'DO_NOT_ARCHIVE=secret\n');
  return { repository, worktree, sessionId };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('worktree recovery package', () => {
  it('reconstructs tracked patches and explicitly selected untracked files without touching source', () => {
    const { repository, worktree, sessionId } = fixture();
    const entry = generateWorktreeManifest({ repositories: [repository] }).entries[0];
    const sourceStatus = execFileSync('git', ['-C', worktree, 'status', '--porcelain=v1'], {
      encoding: 'utf8',
    });
    const packages = temporaryDirectory('mitzo-worktree-recovery-packages-');
    const packageResult = createWorktreeRecoveryPackage({
      entry,
      destinationRoot: packages,
      selectedUntrackedPaths: ['notes.md'],
      packageName: sessionId,
      createdAt: new Date('2026-01-10T00:00:00.000Z'),
    });

    expect(packageResult.path).toBe(join(packages, sessionId));
    expect(statSync(packageResult.path).mode & 0o777).toBe(0o700);
    expect(statSync(join(packageResult.path, 'metadata.json')).mode & 0o777).toBe(0o600);
    expect(existsSync(join(packageResult.path, 'history.bundle'))).toBe(true);
    expect(readFileSync(join(packageResult.path, 'untracked', 'notes.md'), 'utf8')).toBe(
      'selected untracked evidence\n',
    );
    expect(existsSync(join(packageResult.path, 'untracked', '.env'))).toBe(false);

    const rehearsalRoot = temporaryDirectory('mitzo-worktree-recovery-rehearsal-');
    const restored = join(rehearsalRoot, sessionId);
    const rehearsal = rehearseWorktreeRecovery({
      packagePath: packageResult.path,
      destination: restored,
    });

    expect(rehearsal).toMatchObject({ verified: true, destination: restored });
    expect(readFileSync(join(restored, 'staged.txt'), 'utf8')).toBe('staged recovery\n');
    expect(readFileSync(join(restored, 'unstaged.txt'), 'utf8')).toBe('unstaged recovery\n');
    expect(readFileSync(join(restored, 'notes.md'), 'utf8')).toBe('selected untracked evidence\n');
    expect(
      execFileSync('git', ['-C', restored, 'status', '--porcelain=v1'], { encoding: 'utf8' }),
    ).toBe('M  staged.txt\n M unstaged.txt\n?? notes.md\n');
    expect(
      execFileSync('git', ['-C', worktree, 'status', '--porcelain=v1'], { encoding: 'utf8' }),
    ).toBe(sourceStatus);
  });

  it('rejects sensitive files even when they are explicitly selected', () => {
    const { repository } = fixture();
    const entry = generateWorktreeManifest({ repositories: [repository] }).entries[0];
    const packages = temporaryDirectory('mitzo-worktree-recovery-sensitive-');

    expect(() =>
      createWorktreeRecoveryPackage({
        entry,
        destinationRoot: packages,
        selectedUntrackedPaths: ['.env'],
        packageName: 'must-not-exist',
      }),
    ).toThrow('not eligible for recovery packaging');
    expect(existsSync(join(packages, 'must-not-exist'))).toBe(false);
  });

  it('rejects tracked changes that cannot be verified with a working-tree hash', () => {
    const { repository, worktree } = fixture();
    rmSync(join(worktree, 'unstaged.txt'));
    const entry = generateWorktreeManifest({ repositories: [repository] }).entries[0];
    const packages = temporaryDirectory('mitzo-worktree-recovery-deleted-');

    expect(() =>
      createWorktreeRecoveryPackage({
        entry,
        destinationRoot: packages,
        selectedUntrackedPaths: ['notes.md'],
        packageName: 'must-not-exist',
      }),
    ).toThrow('tracked path is not eligible for verified recovery packaging: unstaged.txt');
    expect(existsSync(join(packages, 'must-not-exist'))).toBe(false);
  });
});
