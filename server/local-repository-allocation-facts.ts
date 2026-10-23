import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  inspectLocalRepositoryGitMetadata,
  isLocalRepositoryCredentialPath,
} from './local-repository-git-inspection.js';
import {
  hasLocalRepositoryReferenceConflict,
  readLocalRepositoryGitFacts,
} from './local-repository-git-snapshot.js';
import {
  LocalRepositoryReadAccess,
  type LocalRepositoryReadAnchor,
  type LocalRepositoryReadAuthority,
} from './local-repository-read-access.js';
import type { NativeReadIdentity } from './native-file-operation.js';
import { freezePendingHostTaskData } from './pending-host-task.js';

interface DirectoryStep {
  readonly directory: string;
  readonly rootAnchor: LocalRepositoryReadAnchor;
  readonly parent:
    | {
        readonly kind: 'existing';
        readonly directory: string;
        readonly identity: NativeReadIdentity;
      }
    | { readonly kind: 'created'; readonly directory: string };
}
const unavailable = () => Error('Local repository allocation facts unavailable');
const contains = (root: string, path: string) => {
  const child = relative(root, path);
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
};
const validPath = (path: unknown): path is string =>
  typeof path === 'string' &&
  path.length <= 4096 &&
  Buffer.byteLength(path) <= 4096 &&
  isAbsolute(path) &&
  resolve(path) === path &&
  !path.includes('\0') &&
  !isLocalRepositoryCredentialPath(path);

/** Read-only original pre-approval facts from the EXACT retained qualified read
 * owner. Caller owns/awaits its disposal. These data confer no native or effect
 * authority and do not expose Prepare or replace the existing workspace ledger. */
export async function captureLocalRepositoryAllocationFacts(
  authority: LocalRepositoryReadAuthority,
  input: { workspaceId: string; sourcePath: string; taskRoot: string },
) {
  authority.signal?.throwIfAborted();
  try {
    const workspaceId = z.uuid().parse(input.workspaceId);
    const sourcePath = input.sourcePath,
      taskRoot = input.taskRoot;
    if (!validPath(sourcePath) || !validPath(taskRoot) || contains(sourcePath, taskRoot))
      throw unavailable();
    const access = new LocalRepositoryReadAccess(authority); // Retain, never spread the owner.
    // Independent original roots use the same current owner and existing
    // transport. Join BOTH operations on refusal before disposal/publication.
    const anchors = await Promise.allSettled([
      access.pinRoot(sourcePath),
      access.pinRoot(taskRoot),
    ]);
    const rejected = anchors.find((result) => result.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
    const [sourceAnchor, taskAnchor] = anchors.map((result) => {
      if (result.status !== 'fulfilled') throw unavailable();
      return result.value;
    });
    const metadata = await inspectLocalRepositoryGitMetadata({
      path: sourcePath,
      mode: 'references',
      readAccess: access,
      assertReadable: (path) => access.assertPath(path),
      signal: authority.signal,
      timeoutMs: Math.max(1, Math.min(30000, authority.deadline - Date.now())),
    });
    // Separate administrative roots may live outside the selected worktree.
    // A new task must not be nested inside any original source storage.
    if (contains(metadata.commonDirectory, taskRoot) || contains(metadata.gitDirectory, taskRoot))
      throw unavailable();
    const commonAnchor = await access.pinRoot(metadata.commonDirectory);
    const options = {
      readAccess: access,
      signal: authority.signal,
      timeoutMs: Math.max(1, authority.deadline - Date.now()),
    };
    const { branch, head } = await readLocalRepositoryGitFacts(metadata, options);
    if (!head) throw unavailable();
    const featureBranch = `mitzo/repo-${workspaceId}`;
    const reference = `refs/heads/${featureBranch}`;
    await access.assertPath(join(metadata.commonDirectory, reference));
    if (await hasLocalRepositoryReferenceConflict(metadata, options, reference))
      throw unavailable();
    const directories: DirectoryStep[] = [];
    const known = new Map<string, NativeReadIdentity>([
      [taskRoot, taskAnchor.identity],
      [metadata.commonDirectory, commonAnchor.identity],
    ]);
    const created = new Set<string>();
    const directory = async (
      path: string,
      rootAnchor: LocalRepositoryReadAnchor,
      mustBeAbsent = false,
    ) => {
      await access.assertPath(path);
      const parent = dirname(path);
      const plannedParent = created.has(parent);
      if (!plannedParent && !known.has(parent)) throw unavailable();
      const existing = plannedParent ? undefined : await access.stat(path);
      if (existing) {
        if (mustBeAbsent || existing.kind !== 'directory') throw unavailable();
        known.set(path, existing.identity);
      } else {
        if (directories.length >= 9) throw unavailable();
        directories.push({
          directory: path,
          rootAnchor,
          parent: plannedParent
            ? { kind: 'created', directory: parent }
            : { kind: 'existing', directory: parent, identity: known.get(parent)! },
        });
        created.add(path);
      }
    };
    const destination = join(taskRoot, `repo-${workspaceId}`);
    await directory(destination, taskAnchor, true);
    const common = metadata.commonDirectory;
    for (const parts of [
      ['worktrees'],
      ['refs'],
      ['refs', 'heads'],
      ['refs', 'heads', 'mitzo'],
      ['logs'],
      ['logs', 'refs'],
      ['logs', 'refs', 'heads'],
      ['logs', 'refs', 'heads', 'mitzo'],
    ])
      await directory(join(common, ...parts), commonAnchor);
    const absentPaths = [
      destination,
      join(common, 'worktrees', `repo-${workspaceId}`),
      join(common, reference),
      join(common, reference + '.lock'),
      join(common, 'logs', reference),
      join(common, 'logs', reference + '.lock'),
    ];
    for (const path of absentPaths) {
      await access.assertPath(path);
      if (path === destination) continue;
      if (!created.has(dirname(path)) && (await access.stat(path))) throw unavailable();
    }
    const facts = freezePendingHostTaskData({
      version: 1 as const,
      workspaceId,
      baseOid: head,
      baseBranch: branch ?? head,
      featureBranch,
      source: { ...metadata, sourceAnchor, commonAnchor },
      taskRoot: taskAnchor,
      directories,
      absentPaths,
    });
    // Fixed path/step/count bounds cap serialization at <256KiB even before
    // this stricter outward evidence bound. No unrelated caller data is copied.
    const serialized = JSON.stringify(facts);
    if (Buffer.byteLength(serialized) > 32768) throw unavailable();
    const verify = async () => {
      try {
        await access.verify();
      } catch {
        authority.signal?.throwIfAborted();
        throw unavailable();
      }
    };
    await verify();
    return Object.freeze({
      facts,
      factsSha256: createHash('sha256').update(serialized).digest('hex'),
      verify,
    });
  } catch {
    authority.signal?.throwIfAborted();
    throw unavailable();
  }
}
