import { createHash } from 'node:crypto';
import {
  captureNativeHostReadOwner,
  assertNativeHostReadCurrentSync,
  type NativeHostToolContext,
} from './native-host-tool-context.js';
import type { QualifiedLocalRepositoryPreparationSource } from './local-repository-preparation-authorization.js';
import { captureNativeLocalRepositoryReader } from './local-repository-native-read.js';
import {
  captureLocalRepositoryAllocationFacts,
  type LocalRepositoryAllocationFacts as AllocationFacts,
} from './local-repository-allocation-facts.js';
import { LocalRepositoryReadAccess } from './local-repository-read-access.js';
import { preparationReadDeadline } from './local-repository-preparation-read-policy.js';
import { inspectLocalRepositoryGitMetadata } from './local-repository-git-inspection.js';
import { readLocalRepositoryPreparationBaseReferences } from './local-repository-git-snapshot.js';
import { freezePendingHostTaskData } from './pending-host-task.js';
import type { NativeReadIdentity } from './native-file-operation.js';

export interface NativeQualifiedLocalRepositoryPreparationSource extends QualifiedLocalRepositoryPreparationSource {
  readonly referenceCoverage: 'preparation-head-and-namespace-v1';
  readonly baseBranch: string;
  readonly baseOid: string;
  readonly allocationFacts: AllocationFacts;
  readonly allocationFactsSha256: string;
  /** Original absence facts only, before effects. After owned creation, the
   * materializer must validate its phase-specific actual owned identities. */
  revalidateAllocationFacts(): Promise<void>;
}
const unavailable = () => Error('Local repository preparation source unavailable');
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function numericIdentity(value: NativeReadIdentity) {
  const dev = Number(value.dev),
    ino = Number(value.ino);
  if (!Number.isSafeInteger(dev) || dev < 0 || !Number.isSafeInteger(ino) || ino < 0)
    throw unavailable();
  return { dev, ino };
}
/** Data projection from original read facts only; never a grant/current fence. */
export function localRepositoryPreparationSourceFacts(facts: AllocationFacts) {
  const { source } = facts;
  return freezePendingHostTaskData({
    source: {
      path: source.path,
      gitDirectory: source.gitDirectory,
      commonDirectory: source.commonDirectory,
      root: numericIdentity(source.sourceAnchor.identity),
      commonRoot: numericIdentity(source.commonAnchor.identity),
    },
    baseBranch: facts.baseBranch,
    baseOid: facts.baseOid,
    referenceCoverage: source.referenceCoverage,
    anchorsSha256: hash({
      source: source.sourceAnchor,
      common: source.commonAnchor,
      referenceCoverage: source.referenceCoverage,
    }),
  });
}

/** Private current original-tool composition. This qualifies bounded source
 * metadata/ref bytes, not a clean worktree, complete object tree or effect
 * permission. No selection/allocation/tool registration or ambient Git fallback.
 * Every read attempt has a fresh bounded reader which is disposed in finally;
 * human approval cannot extend an earlier read phase's bounded lifetime. */
export async function captureNativeLocalRepositoryPreparationSource(
  context: NativeHostToolContext,
  input: { workspaceId: string; sourcePath: string; taskRoot: string },
  options?: Readonly<{ deadline: number }>,
): Promise<NativeQualifiedLocalRepositoryPreparationSource> {
  const deadline = options?.deadline ?? Number.POSITIVE_INFINITY;
  if (options && (!Number.isSafeInteger(deadline) || deadline <= Date.now())) throw unavailable();
  const owner = captureNativeHostReadOwner(context);
  const scope = owner?.scope ?? context.nativeBaseReadScope;
  const revalidate = () => (owner ? owner.assertCurrent() : context.assertCurrent());
  const intent = Object.freeze({
    workspaceId: input.workspaceId,
    sourcePath: input.sourcePath,
    taskRoot: input.taskRoot,
  });
  const current = () => {
    context.signal.throwIfAborted();
    if (Date.now() >= deadline) throw unavailable();
    if (!scope || context.nativeBaseReadScope !== scope) throw unavailable();
    if (owner) owner.assertCurrentSync();
    else assertNativeHostReadCurrentSync(context, scope);
  };
  const read = async <T>(
    action: (reader: Awaited<ReturnType<typeof captureNativeLocalRepositoryReader>>) => Promise<T>,
    earlierDeadline = deadline,
  ) => {
    current();
    const reader = await captureNativeLocalRepositoryReader(context, {
      deadline: preparationReadDeadline(Math.min(deadline, earlierDeadline), context.signal),
    });
    try {
      const result = await action(reader);
      current();
      return result;
    } catch {
      current();
      throw unavailable();
    } finally {
      await reader.dispose();
      // Cleanup is an await too: only the still-current original owner may
      // receive facts, independently of the now-disposed read operation.
      await revalidate();
      current();
    }
  };
  const captureAllocation = () =>
    read(async (reader) => {
      const held = await captureLocalRepositoryAllocationFacts(reader, intent);
      // Retain data only, never the expired initial reader/verify closure.
      return { facts: held.facts, factsSha256: held.factsSha256 };
    });
  const initial = await captureAllocation();
  const original = localRepositoryPreparationSourceFacts(initial.facts);
  const originalBaseHash = hash({
    source: original.source,
    baseBranch: original.baseBranch,
    baseOid: original.baseOid,
  });
  const baseCurrent = (earlierDeadline: number) =>
    read(async (reader) => {
      const access = await LocalRepositoryReadAccess.capturePreparationBase(reader, {
        version: 'preparation-base-observation-v1',
        sourceAnchor: initial.facts.source.sourceAnchor,
        gitDirectory: initial.facts.source.gitDirectory,
        commonAnchor: initial.facts.source.commonAnchor,
        deniedRoots: reader.deniedRoots,
      });
      const sourceAnchor = await access.pinRoot(intent.sourcePath);
      const metadata = await inspectLocalRepositoryGitMetadata({
        path: intent.sourcePath,
        mode: 'preparation',
        readAccess: access,
        assertReadable: (path) => access.assertPath(path),
        signal: reader.signal,
        timeoutMs: Math.max(1, reader.deadline - Date.now()),
      });
      const commonAnchor = await access.pinRoot(metadata.commonDirectory);
      const { branch, head } = await readLocalRepositoryPreparationBaseReferences(metadata, {
        readAccess: access,
        signal: reader.signal,
        timeoutMs: Math.max(1, reader.deadline - Date.now()),
      });
      await access.verify();
      // This phase freshly qualifies base identity/paths/branch/OID only. The
      // original namespace/absence digest remains historical; complete fresh
      // allocation checks occur separately BEFORE effects.
      const actual = {
        source: {
          path: metadata.path,
          gitDirectory: metadata.gitDirectory,
          commonDirectory: metadata.commonDirectory,
          root: numericIdentity(sourceAnchor.identity),
          commonRoot: numericIdentity(commonAnchor.identity),
        },
        baseBranch: branch ?? head,
        baseOid: head,
      };
      if (hash(actual) !== originalBaseHash) throw unavailable();
    }, earlierDeadline);
  return Object.freeze({
    ...original,
    allocationFacts: initial.facts,
    allocationFactsSha256: initial.factsSha256,
    assertCurrentSync: current,
    async assertCurrent(options?: Readonly<{ deadline: number }>) {
      current();
      const earlierDeadline = options?.deadline ?? deadline;
      preparationReadDeadline(Math.min(deadline, earlierDeadline), context.signal);
      await revalidate();
      current();
      await baseCurrent(earlierDeadline);
      current();
      preparationReadDeadline(Math.min(deadline, earlierDeadline), context.signal);
    },
    async revalidateAllocationFacts() {
      const actual = await captureAllocation();
      if (actual.factsSha256 !== initial.factsSha256) throw unavailable();
      current();
    },
  });
}
