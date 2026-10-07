import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
/** Offline integrity of an operator-selected canonical baseline; freshness is separate.
 * The owning release inspector supplies the real operator's canonical root. */
export function assertCanonicalOwnedSource(
  release: string,
  root: string,
  acceptedMainBaseline: string,
) {
  function fail(): never {
    throw Error('Canonical owned source identity/publication refused');
  }
  const stat = lstatSync(root);
  if (
    !/^[a-f0-9]{40}$/.test(acceptedMainBaseline ?? '') ||
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
    const match = /^([a-z_]+)=(.*)$/.exec(line);
    if (!match || fields.has(match[1])) fail();
    const [, name, value] = match;
    if (['source_commit', 'source_tree', 'base_main'].includes(name)) {
      if (!/^[a-f0-9]{40}$/.test(value)) fail();
    } else if (name === 'source_ref') {
      // Informational only: never selects source, supplies ancestry or executes.
      if (
        !value ||
        value.length > 1024 ||
        /\s/.test(value) ||
        [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
      )
        fail();
    } else if (name === 'created_at') {
      if (
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) ||
        Number.isNaN(Date.parse(value)) ||
        new Date(value).toISOString().replace('.000Z', 'Z') !== value
      )
        fail();
    } else fail();
    fields.set(name, value);
  }
  const sourceCommit = fields.get('source_commit'),
    sourceTree = fields.get('source_tree'),
    baseMain = fields.get('base_main');
  if (
    !sourceCommit ||
    !sourceTree ||
    !baseMain ||
    baseMain !== acceptedMainBaseline ||
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
    realpathSync(git(['rev-parse', '--show-toplevel'])) !== release ||
    git(['rev-parse', 'HEAD']) !== sourceCommit ||
    git(['rev-parse', 'HEAD^{tree}']) !== sourceTree ||
    git(['status', '--porcelain', '--untracked-files=no']) ||
    !['https://github.com/dimakis/mitzo.git', 'git@github.com:dimakis/mitzo.git'].includes(
      git(['remote', 'get-url', 'origin']),
    ) ||
    git(['rev-parse', '--abbrev-ref', 'HEAD']) !== 'HEAD'
  )
    fail();
  const index = git(['ls-files', '-v']).split('\n').filter(Boolean);
  if (!index.length || index.some((line) => !line.startsWith('H '))) fail();
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
