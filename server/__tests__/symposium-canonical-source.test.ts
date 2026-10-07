import { afterEach, expect, it } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { assertCanonicalOwnedSource } from '../symposium-canonical-source.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const stage = realpathSync(mkdtempSync(join(tmpdir(), 'symposium-source-')));
  chmodSync(stage, 0o700);
  roots.push(stage);
  mkdirSync(join(stage, 'releases'), { mode: 0o700 });
  let release = join(stage, 'releases', 'preparing');
  mkdirSync(release, { mode: 0o700 });
  const git = (args: string[]) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
      cwd: release,
      encoding: 'utf8',
    }).trim();
  git(['init', '-q']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['remote', 'add', 'origin', 'https://github.com/dimakis/mitzo.git']);
  writeFileSync(join(release, '.gitignore'), 'release.txt\n');
  writeFileSync(join(release, 'source'), 'ancestor');
  git(['add', '.']);
  git(['commit', '-qm', 'ancestor']);
  const ancestor = git(['rev-parse', 'HEAD']);
  writeFileSync(join(release, 'source'), 'base');
  git(['add', '.']);
  git(['commit', '-qm', 'base']);
  const base = git(['rev-parse', 'HEAD']);
  git(['update-ref', 'refs/remotes/origin/main', base]);
  writeFileSync(join(release, 'source'), 'feature');
  git(['commit', '-qam', 'feature']);
  const source = git(['rev-parse', 'HEAD']);
  const tree = git(['rev-parse', 'HEAD^{tree}']);
  git(['update-ref', 'refs/remotes/origin/feature', source]);
  git(['checkout', '--detach', '-q', base]);
  writeFileSync(join(release, 'source'), 'later main');
  git(['commit', '-qam', 'main advances']);
  git(['update-ref', 'refs/remotes/origin/main', git(['rev-parse', 'HEAD'])]);
  git(['checkout', '--detach', '-q', source]);
  const final = join(stage, 'releases', source.slice(0, 12));
  renameSync(release, final);
  release = final;
  const manifest = `source_commit=${source}\nbase_main=${base}\nsource_tree=${tree}\n`;
  writeFileSync(join(release, 'release.txt'), manifest);
  return { stage, release, git, source, tree, base, ancestor, manifest };
}
it('keeps an intact published canonical release valid after cached main advances', () => {
  const f = fixture();
  expect(assertCanonicalOwnedSource(f.release, f.stage, f.base)).toEqual({
    sourceCommit: f.source,
    sourceTree: f.tree,
    baseMain: f.base,
  });
});
it.each(['dirty', 'unpublished', 'unaccepted-base', 'wrong-tree', 'wrong-root'])(
  'refuses canonical source %s drift',
  (kind) => {
    const f = fixture();
    if (kind === 'dirty') writeFileSync(join(f.release, 'source'), 'changed');
    if (kind === 'unpublished') f.git(['update-ref', '-d', 'refs/remotes/origin/feature']);
    if (kind === 'unaccepted-base')
      writeFileSync(join(f.release, 'release.txt'), f.manifest.replace(f.base, f.source));
    if (kind === 'wrong-tree')
      writeFileSync(join(f.release, 'release.txt'), f.manifest.replace(f.tree, 'a'.repeat(40)));
    expect(() =>
      assertCanonicalOwnedSource(
        f.release,
        kind === 'wrong-root' ? join(f.stage, 'other') : f.stage,
        f.base,
      ),
    ).toThrow();
    expect(readFileSync(join(f.release, 'source'), 'utf8')).toBe(
      kind === 'dirty' ? 'changed' : 'feature',
    );
  },
);

it('accepts the standard release manifest metadata without trusting it as source identity', () => {
  const f = fixture();
  writeFileSync(
    join(f.release, 'release.txt'),
    f.manifest + 'source_ref=origin/feature\ncreated_at=2026-10-06T18:00:00Z\n',
  );
  expect(assertCanonicalOwnedSource(f.release, f.stage, f.base)).toEqual({
    sourceCommit: f.source,
    sourceTree: f.tree,
    baseMain: f.base,
  });
});
it.each([
  'source_commit=' + 'a'.repeat(40),
  'source_ref=first\nsource_ref=second',
  'created_at=not-a-date',
  'unexpected=value',
])('rejects ambiguous or malformed release metadata %s', (extra) => {
  const f = fixture();
  writeFileSync(join(f.release, 'release.txt'), f.manifest + extra + '\n');
  expect(() => assertCanonicalOwnedSource(f.release, f.stage, f.base)).toThrow();
});

it('accepts the pinned SSH origin without accepting other repositories', () => {
  const f = fixture();
  f.git(['remote', 'set-url', 'origin', 'git@github.com:dimakis/mitzo.git']);
  expect(() => assertCanonicalOwnedSource(f.release, f.stage, f.base)).not.toThrow();
  f.git(['remote', 'set-url', 'origin', 'git@github.com:other/mitzo.git']);
  expect(() => assertCanonicalOwnedSource(f.release, f.stage, f.base)).toThrow();
});

it.each(['--assume-unchanged', '--skip-worktree'])(
  'refuses hidden tracked source edits under %s',
  (flag) => {
    const f = fixture();
    f.git(['update-index', flag, 'source']);
    writeFileSync(join(f.release, 'source'), 'hidden unreviewed source');
    expect(f.git(['status', '--porcelain', '--untracked-files=no'])).toBe('');
    expect(() => assertCanonicalOwnedSource(f.release, f.stage, f.base)).toThrow();
    expect(readFileSync(join(f.release, 'source'), 'utf8')).toBe('hidden unreviewed source');
  },
);

it('refuses a clean redirected Git worktree while release files differ', () => {
  const f = fixture();
  const clean = join(f.stage, 'clean-worktree');
  mkdirSync(clean, { mode: 0o700 });
  writeFileSync(join(clean, '.gitignore'), 'release.txt\n');
  writeFileSync(join(clean, 'source'), 'feature');
  f.git(['config', 'core.worktree', clean]);
  writeFileSync(join(f.release, 'source'), 'unreviewed release bytes');
  expect(f.git(['status', '--porcelain', '--untracked-files=no'])).toBe('');
  expect(() => assertCanonicalOwnedSource(f.release, f.stage, f.base)).toThrow();
  expect(readFileSync(join(f.release, 'source'), 'utf8')).toBe('unreviewed release bytes');
});
it('refuses a different accepted ancestor substituted into editable release metadata', () => {
  const f = fixture();
  writeFileSync(join(f.release, 'release.txt'), f.manifest.replace(f.base, f.ancestor));
  expect(() => assertCanonicalOwnedSource(f.release, f.stage, f.base)).toThrow();
});
it('requires an independently supplied full accepted baseline', () => {
  const f = fixture();
  for (const baseline of [undefined, '', 'a'.repeat(39)])
    expect(() => assertCanonicalOwnedSource(f.release, f.stage, baseline as string)).toThrow();
});
