import { realpathSync } from 'node:fs';
import type { GithubPublishingSource } from './github-publishing-tool.js';

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
