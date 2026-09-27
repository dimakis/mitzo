import { committedTreeDigest } from '../symposium-review-publication.js';
import { SYMPOSIUM_ARTIFACT_TARGET } from '../symposium-artifact-lease.js';
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ARTIFACT_GIT_VERIFIER } from '../symposium-artifact-git-verifier.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'artifact-git-proof-'));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString();
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  writeFileSync(join(root, 'file.txt'), 'committed\n');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'test');
  const run = () =>
    JSON.parse(
      execFileSync(
        'python3',
        [
          '-I',
          '-c',
          ARTIFACT_GIT_VERIFIER.replace(
            `root='${SYMPOSIUM_ARTIFACT_TARGET}'`,
            `root=${JSON.stringify(root)}`,
          ),
          '.',
        ],
        { stdio: 'pipe' },
      ).toString(),
    );
  return { root, git, run };
}
it('proves the exact committed tree and content without running Git filters', () => {
  const f = fixture();
  writeFileSync(join(f.root, '.gitattributes'), 'file.txt filter=attack\n');
  f.git('add', '.gitattributes');
  f.git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'attributes');
  f.git('config', 'filter.attack.clean', 'touch SHOULD_NOT_EXIST');
  const proof = f.run();
  expect(proof.commit).toBe(f.git('rev-parse', 'HEAD').trim());
  expect(proof.tree).toBe(f.git('rev-parse', 'HEAD^{tree}').trim());
  expect(proof.entries).toBe(2);
  expect(proof.committedTreeDigest).toBe(
    committedTreeDigest(f.git('ls-tree', '-r', '-z', '--full-tree', 'HEAD')),
  );
});
it.each(['edited', 'staged', 'untracked', 'symlink', 'alternate'])(
  'rejects %s artifact state',
  (kind) => {
    const f = fixture();
    if (kind === 'edited') writeFileSync(join(f.root, 'file.txt'), 'dirty');
    if (kind === 'staged') {
      writeFileSync(join(f.root, 'file.txt'), 'staged');
      f.git('add', 'file.txt');
      writeFileSync(join(f.root, 'file.txt'), 'committed\n');
    }
    if (kind === 'untracked') writeFileSync(join(f.root, 'extra'), 'untracked');
    if (kind === 'symlink') symlinkSync('/etc/passwd', join(f.root, '.git', 'escape'));
    if (kind === 'alternate')
      writeFileSync(join(f.root, '.git', 'objects', 'info', 'alternates'), '/tmp/other');
    expect(f.run).toThrow();
  },
);
