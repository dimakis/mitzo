import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  inspectLocalRepositoryGitMetadata,
  isLocalRepositoryCredentialPath,
} from './local-repository-git-inspection.js';
import { readLocalRepositoryPreparationReferences } from './local-repository-git-snapshot.js';
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
export type LocalRepositoryAllocationFacts = Awaited<
  ReturnType<typeof captureLocalRepositoryAllocationFacts>
>['facts'];
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
    await access.listPinnedRoots([sourcePath, taskRoot]);
    const destination = join(taskRoot, `repo-${workspaceId}`);
    // These disjoint source/task operations share the same original owner and
    // deadline. Join both on refusal; neither can publish facts independently.
    const initial = await Promise.allSettled([
      inspectLocalRepositoryGitMetadata({
        path: sourcePath,
        mode: 'preparation',
        readAccess: access,
        assertReadable: (path) => access.assertPath(path),
        signal: authority.signal,
        timeoutMs: Math.max(1, authority.deadline - Date.now()),
      }),
      access.assertAbsent(destination),
    ]);
    for (const result of initial) if (result.status === 'rejected') throw result.reason;
    const inspected = initial[0];
    if (inspected.status !== 'fulfilled') throw unavailable();
    const metadata = inspected.value;
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
    const featureBranch = `mitzo/repo-${workspaceId}`;
    const reference = `refs/heads/${featureBranch}`;
    const { branch, head, conflict, referenceCoverage } =
      await readLocalRepositoryPreparationReferences(metadata, options, reference);
    if (!head) throw unavailable();
    await access.assertPath(join(metadata.commonDirectory, reference));
    if (conflict) throw unavailable();
    const directories: DirectoryStep[] = [];
    const known = new Map<string, NativeReadIdentity>([
      [taskRoot, taskAnchor.identity],
      [metadata.commonDirectory, commonAnchor.identity],
    ]);
    const created = new Set<string>();
    const physicalAbsences = new Set<string>();
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
        physicalAbsences.add(path);
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
      physicalAbsences.add(path);
    }
    // Only the first missing parent needs a physical lookup. Its descendants
    // are separately authorized above and remain bound to that retained parent
    // listing. Independent probes use bounded pairs and join on every failure.
    const missing = [...physicalAbsences].filter(
      (path) => ![...physicalAbsences].some((parent) => parent !== path && contains(parent, path)),
    );
    let next = 0;
    let refused = false;
    const probe = async () => {
      while (!refused && next < missing.length) {
        const path = missing[next++];
        try {
          await access.assertAbsent(path);
        } catch (error) {
          refused = true;
          throw error;
        }
      }
    };
    const probes = await Promise.allSettled([probe(), probe()]);
    for (const result of probes) if (result.status === 'rejected') throw result.reason;
    const facts = freezePendingHostTaskData({
      version: 1 as const,
      workspaceId,
      baseOid: head,
      baseBranch: branch ?? head,
      featureBranch,
      source: { ...metadata, referenceCoverage, sourceAnchor, commonAnchor },
      taskRoot: taskAnchor,
      directories,
      // Every original existing publication parent must survive approval and
      // fresh capture by identity, including parents that need no mkdir step.
      existingDirectories: [...known].map(([directory, identity]) => ({ directory, identity })),
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
    // Private publication precondition from the EXACT entry/bytes already
    // consumed by the successful namespace parser in THIS ReadAccess. This is
    // outside the original permission/facts hash and confers no new authority.
    const packedPath = join(metadata.commonDirectory, 'packed-refs');
    const packedEntry = await access.stat(packedPath);
    if (packedEntry && (packedEntry.kind !== 'file' || packedEntry.nlink !== 1))
      throw unavailable();
    const publicationPackedRefs = packedEntry
      ? Object.freeze({
          kind: 'file' as const,
          identity: Object.freeze({ ...packedEntry.identity }),
          size: packedEntry.size,
          sha256: createHash('sha256')
            .update(await access.read(packedPath, 16 * 1024 * 1024))
            .digest('hex'),
        })
      : Object.freeze({ kind: 'absent' as const });
    await verify();
    return Object.freeze({
      publicationPackedRefs,
      facts,
      factsSha256: createHash('sha256').update(serialized).digest('hex'),
      verify,
    });
  } catch {
    authority.signal?.throwIfAborted();
    throw unavailable();
  }
}
