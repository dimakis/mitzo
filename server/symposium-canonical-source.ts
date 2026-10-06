import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
/** Offline integrity of an operator-selected canonical baseline; freshness is separate.
 * The owning release inspector supplies the real operator's canonical root. */
export function assertCanonicalOwnedSource(release: string, root: string) {
  function fail(): never {
    throw Error('Canonical owned source identity/publication refused');
  }
  const stat = lstatSync(root);
  if (
    realpathSync(root) !== root ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700 ||
    !stat.isDirectory() ||
    realpathSync(release) !== release
  )
    fail();
  const path = join(release, 'release.txt');
  const file = lstatSync(path);
  if (
    !file.isFile() ||
    file.isSymbolicLink() ||
    file.size > 65536 ||
    file.uid !== process.getuid?.()
  )
    fail();
  const fields = new Map<string, string>();
  for (const line of readFileSync(path, 'utf8').trim().split('\n')) {
    const match = /^(source_commit|source_tree|base_main)=([a-f0-9]{40})$/.exec(line);
    if (!match || fields.has(match[1])) fail();
    fields.set(match[1], match[2]);
  }
  const sourceCommit = fields.get('source_commit'),
    sourceTree = fields.get('source_tree'),
    baseMain = fields.get('base_main');
  if (
    !sourceCommit ||
    !sourceTree ||
    !baseMain ||
    release !== join(root, 'releases', sourceCommit.slice(0, 12))
  )
    fail();
  const git = (args: string[]) =>
    execFileSync(
      '/usr/bin/git',
      ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args],
      {
        cwd: release,
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 65536,
        env: {
          PATH: '/usr/bin:/bin',
          HOME: root,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_OPTIONAL_LOCKS: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).trim();
  if (
    git(['rev-parse', 'HEAD']) !== sourceCommit ||
    git(['rev-parse', 'HEAD^{tree}']) !== sourceTree ||
    git(['status', '--porcelain', '--untracked-files=no']) ||
    git(['remote', 'get-url', 'origin']) !== 'https://github.com/dimakis/mitzo.git' ||
    git(['rev-parse', '--abbrev-ref', 'HEAD']) !== 'HEAD'
  )
    fail();
  git(['merge-base', '--is-ancestor', baseMain, 'refs/remotes/origin/main']);
  git(['merge-base', '--is-ancestor', baseMain, sourceCommit]);
  const refs = git([
    'for-each-ref',
    '--format=%(refname)|%(symref)',
    '--contains',
    sourceCommit,
    'refs/remotes/origin',
  ]).split('\n');
  if (!refs.some((ref) => /^refs\/remotes\/origin\/[^|]+\|$/.test(ref))) fail();
  return { sourceCommit, sourceTree, baseMain };
}
