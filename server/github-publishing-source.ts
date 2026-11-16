import { realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import type { EventStore } from './event-store.js';
import type { GithubPublishingSource } from './github-publishing-tool.js';
import type { RepositoryTaskCheckout } from './repository-task-checkout.js';

interface PreparedTaskStorage {
  directory?: string;
  taskIdentity?: {
    linkedGit?: { directory: string };
    localSource?: { commonDirectory: string };
  };
}

/** Acquired source storage is not a standalone task's live Git storage. Only
 * a linked task needs the original shared directory outside its workspace. */
export function githubPublishingGitStorageRoots(
  session: { cwd?: string },
  prepared?: PreparedTaskStorage,
  configured: readonly string[] = [],
): readonly string[] {
  const task = prepared?.directory === session.cwd ? prepared?.taskIdentity : undefined;
  return [
    ...(task?.linkedGit && task.localSource ? [task.localSource.commonDirectory] : []),
    ...configured,
  ];
}

/** An ordinary Claude SDK chat attaches existing local repositories as linked
 * secondary tasks under `<cwd>/.claude/repository-tasks`. Their shared Git
 * directory lives outside the workspace, so admit it only from the
 * controller-written `worktree_opened` record (the same record shape
 * sdk-secondary-repository.ts retains), and only while the task is attached.
 * This read stays synchronous because the publishing source is re-captured on
 * every currency check; the host boundary still verifies the real storage. */
export function sdkSecondaryGithubStorageRoots(
  events: Pick<EventStore, 'getSessionWorktreeRecords'>,
  session: {
    sessionId?: string;
    cwd?: string;
    worktreePaths: ReadonlyMap<string, { path: string }>;
  },
): readonly string[] {
  if (!session.sessionId || !session.cwd) return [];
  const taskRoot = join(session.cwd, '.claude', 'repository-tasks');
  const attached = new Set([...session.worktreePaths.values()].map((entry) => entry.path));
  const roots: string[] = [];
  for (const record of events.getSessionWorktreeRecords(session.sessionId)) {
    const task = record.task as Partial<RepositoryTaskCheckout> | undefined;
    const source = task?.localSource;
    const inTaskRoot = typeof record.path === 'string' ? relative(taskRoot, record.path) : '';
    if (
      record.sdkSecondary !== true ||
      typeof record.path !== 'string' ||
      !attached.has(record.path) ||
      !inTaskRoot ||
      inTaskRoot.startsWith('..') ||
      isAbsolute(inTaskRoot) ||
      !task?.linkedGit ||
      task.directory !== record.path ||
      !source ||
      source.path !== record.sourcePath ||
      typeof source.commonDirectory !== 'string'
    )
      continue;
    roots.push(source.commonDirectory);
  }
  return roots;
}

/** Paths come from the current controller-owned session, never tool arguments.
 * Resolve each lexical root once per snapshot; later owner checks take a fresh
 * snapshot and never reuse filesystem authority across an effect boundary. */
export function hostGithubPublishingSource(
  session: { cwd?: string },
  gitStorageRoots: readonly string[] = [],
  prepared?: {
    directory?: string;
    repository: string;
    baseBranch: string;
    baseOid: string;
    connectionId?: string;
  },
): Extract<GithubPublishingSource, { runtime: 'host' }> | undefined {
  try {
    if (!session.cwd) return undefined;
    const workspace = realpathSync(session.cwd);
    return {
      runtime: 'host',
      workspace,
      gitStorageRoots: [
        ...new Set([...new Set(gitStorageRoots)].map((root) => realpathSync(root))),
      ],
      ...(prepared?.directory === session.cwd
        ? {
            preparedBase: {
              repositoryPath: workspace,
              ...(prepared.connectionId === 'local' ? {} : { repository: prepared.repository }),
              baseBranch: prepared.baseBranch,
              baseOid: prepared.baseOid,
            },
          }
        : {}),
    };
  } catch {
    return undefined;
  }
}
