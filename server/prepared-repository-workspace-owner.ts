import { basename, isAbsolute, join, relative } from 'node:path';
import type { RepositoryTaskCheckout } from './repository-task-checkout.js';
import type { LocalRepositoryReadAccess } from './local-repository-read-access.js';
import { inspectLocalRepositoryGitMetadata } from './local-repository-git-inspection.js';

const unavailable = () => Error('Qualified repository task custody unavailable');
const equal = (actual: { dev: string; ino: string }, expected: { dev: number; ino: number }) =>
  actual.dev === String(expected.dev) && actual.ino === String(expected.ino);

/** Mechanism only, never custody or read authority. The actual native owner
 * supplies a fresh anchored access and independently asserts persisted adoption.
 * Validate stable topology, not creation index/ref/log identities or hashes, so
 * ordinary task edits and commits can advance after the guarded transition. */
export async function assertPreparedRepositoryTaskTopology(
  access: LocalRepositoryReadAccess,
  input: Readonly<RepositoryTaskCheckout>,
  sourceGitDirectory: string,
): Promise<void> {
  const task = structuredClone(input),
    source = task.localSource,
    linked = task.linkedGit;
  if (
    !source ||
    !linked ||
    !/^mitzo\/[A-Za-z0-9._/-]+$/.test(task.featureBranch) ||
    task.featureBranch.includes('..') ||
    ![
      task.directory,
      source.path,
      source.commonDirectory,
      linked.directory,
      sourceGitDirectory,
    ].every(isAbsolute) ||
    linked.directory !== join(source.commonDirectory, 'worktrees', basename(task.directory))
  )
    throw unavailable();
  const roots = [
    [task.directory, task.root],
    [source.path, source.root],
    [source.commonDirectory, source.commonRoot],
    [linked.directory, linked.identity],
  ] as const;
  for (const [path, identity] of roots)
    if (!equal((await access.pinRoot(path)).identity, identity)) throw unavailable();
  // Re-resolve the retained source's gitfile/commondir through the original
  // anchored reader. Source/common inode equality alone does not pin their
  // relationship. This compact view qualifies topology only, never all refs,
  // object storage, status or new read authority.
  const metadata = await inspectLocalRepositoryGitMetadata({
    path: source.path,
    mode: 'preparation',
    readAccess: access,
    assertReadable: (path) => access.assertPath(path),
    timeoutMs: 30000,
  });
  if (
    metadata.path !== source.path ||
    metadata.gitDirectory !== sourceGitDirectory ||
    metadata.commonDirectory !== source.commonDirectory
  )
    throw unavailable();
  await access.preloadDirectories(roots.map(([path]) => path));
  const pointer = join(task.directory, '.git');
  const entry = await access.stat(pointer);
  if (entry?.kind !== 'file' || entry.nlink !== 1 || !equal(entry.identity, task.git))
    throw unavailable();
  for (const [path, expected] of [
    [pointer, `gitdir: ${linked.directory}\n`],
    [
      join(linked.directory, 'commondir'),
      relative(linked.directory, source.commonDirectory) + '\n',
    ],
    [join(linked.directory, 'gitdir'), pointer + '\n'],
    [join(linked.directory, 'HEAD'), `ref: refs/heads/${task.featureBranch}\n`],
  ]) {
    if (!(await access.read(path, 4096)).equals(Buffer.from(expected))) throw unavailable();
  }
  const index = await access.stat(join(linked.directory, 'index'));
  if (index?.kind !== 'file' || index.nlink !== 1) throw unavailable();
  const reference = await access.read(
    join(source.commonDirectory, 'refs', 'heads', task.featureBranch),
    128,
  );
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?\n$/.test(reference.toString('utf8'))) throw unavailable();
  await access.verify();
}
