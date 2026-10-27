import type { RepositoryObservationCapture } from './native-repository-observation.js';
import { mkdtemp, realpath, lstat, rm, writeFile } from 'node:fs/promises';
import { RepositoryHostProcessUncertainError } from './local-repository-host-git.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireRemoteRepositoryBase,
  localRepositoryRemote,
  readLocalRepositoryBaseReference,
  initializeLocalRepositorySource,
  repositorySourceIdentity,
  type RepositorySourceIntent,
  type RepositoryBaseIntent,
  type ResolvedRepositoryBase,
} from './local-repository-base.js';
import type { NativeLocalRepositoryRemoteAuthorization } from './native-local-repository-preparation.js';
import type { LocalRepositoryGitMetadata } from './local-repository-git-inspection.js';
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
import {
  readLocalRepositoryPreparationBaseReferences,
  readLocalRepositoryGitFacts,
} from './local-repository-git-snapshot.js';
import { freezePendingHostTaskData } from './pending-host-task.js';
import type { NativeReadIdentity } from './native-file-operation.js';
import {
  retainPreparationPackedRefs,
  type PreparationPackedRefs,
} from './local-repository-preparation-packed-refs.js';

export interface NativeQualifiedLocalRepositoryPreparationSource extends QualifiedLocalRepositoryPreparationSource {
  readonly objectSource?: LocalRepositoryGitMetadata;
  dispose?(): Promise<void>;
  readonly referenceCoverage: 'preparation-head-and-namespace-v1';
  readonly baseBranch: string;
  readonly baseOid: string;
  readonly allocationFacts: AllocationFacts;
  readonly allocationFactsSha256: string;
  readonly publicationPackedRefs: PreparationPackedRefs;
  /** Original absence facts only, before effects. After owned creation, the
   * materializer must validate its phase-specific actual owned identities. */
  revalidateAllocationFacts(): Promise<void>;
}
const unavailable = () => Error('Local repository preparation source unavailable');
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
interface PreparationSourceInput {
  workspaceId: string;
  sourcePath: string;
  taskRoot: string;
  base?: RepositoryBaseIntent;
  source?: RepositorySourceIntent;
}
interface PreparationSourceOptions {
  deadline: number;
  authorizeRemote?: NativeLocalRepositoryRemoteAuthorization;
  preparedBase?: ResolvedRepositoryBase;
  preparedRemote?: string;
  ownedSource?: true;
}

async function captureOwnedRepositoryPreparationSource(
  context: NativeHostToolContext,
  input: PreparationSourceInput,
  options: Readonly<PreparationSourceOptions>,
): Promise<NativeQualifiedLocalRepositoryPreparationSource> {
  const source = input.source!;
  if (source.kind === 'existing' || repositorySourceIdentity(source) !== input.sourcePath)
    throw unavailable();
  await context.assertCurrent();
  context.signal.throwIfAborted();
  if (!Number.isSafeInteger(options.deadline) || options.deadline <= Date.now())
    throw unavailable();
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-repository-source-')));
  const original = await lstat(scratch, { bigint: true });
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    const actual = await lstat(scratch, { bigint: true });
    if (!actual.isDirectory() || actual.dev !== original.dev || actual.ino !== original.ino)
      throw unavailable();
    await rm(scratch, { recursive: true, force: true });
    disposed = true;
  };
  try {
    await writeFile(
      join(scratch, 'operation.json'),
      JSON.stringify({
        version: 1,
        workspaceId: input.workspaceId,
        conversationId: context.conversationId,
        prepareCallId: context.callId,
        source,
        base: input.base,
        directory: scratch,
        root: { dev: String(original.dev), ino: String(original.ino) },
        state: 'acquiring',
      }),
      { flag: 'wx', mode: 0o600 },
    );
    const directory = join(scratch, 'repository'),
      baseIntent = input.base ?? { kind: 'default' as const };
    let preparedBase: ResolvedRepositoryBase;
    if (source.kind === 'clone') {
      if (!options.authorizeRemote)
        throw Error('Repository network acquisition access is required');
      const run = await options.authorizeRemote(context, {
        url: source.url,
        directory,
        base: baseIntent,
        deadline: options.deadline,
        signal: context.signal,
      });
      preparedBase = await acquireRemoteRepositoryBase(
        {
          repositoryId: input.sourcePath,
          url: source.url,
          directory,
          base: baseIntent,
          signal: context.signal,
        },
        run,
      );
    } else {
      if (
        baseIntent.kind === 'ref' &&
        !['HEAD', 'main', 'refs/heads/main'].includes(baseIntent.ref)
      )
        throw Error('A new repository starts on main');
      preparedBase = await initializeLocalRepositorySource(
        directory,
        input.sourcePath,
        context.signal,
      );
    }
    await context.assertCurrent();
    context.signal.throwIfAborted();
    const qualified = await captureNativeLocalRepositoryPreparationSource(
      context,
      { ...input, sourcePath: directory, base: baseIntent },
      Object.freeze({
        ...options,
        preparedBase,
        ...(source.kind === 'clone' ? { preparedRemote: source.url } : {}),
        ownedSource: true,
      }),
    );
    return Object.freeze(
      Object.defineProperties(
        {},
        {
          ...Object.getOwnPropertyDescriptors(qualified),
          dispose: {
            value: async () => {
              try {
                await qualified.dispose?.();
              } finally {
                await dispose();
              }
            },
            enumerable: true,
          },
        },
      ),
    ) as NativeQualifiedLocalRepositoryPreparationSource;
  } catch (error) {
    if (!(error instanceof RepositoryHostProcessUncertainError)) await dispose();
    throw error;
  }
}
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
  input: PreparationSourceInput,
  options?: Readonly<PreparationSourceOptions>,
): Promise<NativeQualifiedLocalRepositoryPreparationSource> {
  if (input.source && input.source.kind !== 'existing' && !options?.ownedSource) {
    if (!options) throw unavailable();
    return captureOwnedRepositoryPreparationSource(context, input, options);
  }
  const deadline = options?.deadline ?? Number.POSITIVE_INFINITY;
  if (options && (!Number.isSafeInteger(deadline) || deadline <= Date.now())) throw unavailable();
  const owner = captureNativeHostReadOwner(context);
  const scope = owner?.scope ?? context.nativeBaseReadScope;
  const revalidate = () => (owner ? owner.assertCurrent() : context.assertCurrent());
  const intent = Object.freeze({
    workspaceId: input.workspaceId,
    sourcePath: input.sourcePath,
    taskRoot: input.taskRoot,
    ...(input.base ? { base: input.base, layout: 'standalone' as const } : {}),
    ...(input.source ? { source: input.source } : {}),
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
  let resolvedBase: ResolvedRepositoryBase | undefined = options?.preparedBase;
  let remote = options?.preparedRemote;
  let objectSource: LocalRepositoryGitMetadata | undefined;
  let disposeAcquired: (() => Promise<void>) | undefined;
  const captureAllocation = () =>
    read(async (reader) => {
      const held = await captureLocalRepositoryAllocationFacts(reader, {
        ...intent,
        ...(resolvedBase ? { resolvedBase } : {}),
        ...(remote ? { remote } : {}),
      });
      // Retain data only, never the expired initial reader/verify closure.
      return {
        facts: held.facts,
        factsSha256: held.factsSha256,
        publicationPackedRefs: retainPreparationPackedRefs(held.publicationPackedRefs),
      };
    });
  let initial = await captureAllocation();
  try {
    if (input.base && !resolvedBase) {
      const selected = await read(async (reader) => {
        const access = new LocalRepositoryReadAccess(reader);
        await access.pinRoot(input.sourcePath);
        await access.pinRoot(initial.facts.source.commonDirectory);
        const value =
          input.base!.kind === 'default'
            ? {
                url: await localRepositoryRemote(
                  await access.read(join(initial.facts.source.commonDirectory, 'config'), 65536),
                ),
              }
            : await readLocalRepositoryBaseReference(access, initial.facts.source, input.base!.ref);
        await access.verify();
        return value;
      });
      const repositoryId = `existing-${createHash('sha256').update(input.sourcePath).digest('hex')}`;
      if ('url' in selected) {
        remote = selected.url;
        if (!options?.authorizeRemote)
          throw Error('Repository network acquisition access is required');
        current();
        const scratch = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-base-acquisition-')));
        const original = await lstat(scratch, { bigint: true });
        disposeAcquired = async () => {
          const actual = await lstat(scratch, { bigint: true });
          if (!actual.isDirectory() || actual.dev !== original.dev || actual.ino !== original.ino)
            throw unavailable();
          await rm(scratch, { recursive: true, force: true });
        };
        await writeFile(
          join(scratch, 'operation.json'),
          JSON.stringify({
            version: 1,
            workspaceId: input.workspaceId,
            conversationId: context.conversationId,
            prepareCallId: context.callId,
            source: input.source ?? { kind: 'existing', path: input.sourcePath },
            base: input.base,
            directory: scratch,
            root: { dev: String(original.dev), ino: String(original.ino) },
            state: 'acquiring',
          }),
          { flag: 'wx', mode: 0o600 },
        );
        const directory = join(scratch, 'repository');
        const run = await options.authorizeRemote(context, {
          url: selected.url,
          directory,
          base: input.base,
          deadline,
          signal: context.signal,
        });
        current();
        resolvedBase = await acquireRemoteRepositoryBase(
          { repositoryId, url: selected.url, directory, base: input.base, signal: context.signal },
          run,
        );
        current();
        objectSource = {
          path: directory,
          gitDirectory: join(directory, '.git'),
          commonDirectory: join(directory, '.git'),
          objectFormat: resolvedBase.oid.length === 64 ? 'sha256' : 'sha1',
          comparisonConfig: {},
        };
      } else
        resolvedBase = {
          repositoryId,
          oid: selected.oid,
          ...(selected.branch ? { branch: selected.branch } : {}),
          origin: 'local',
        };
      initial = await captureAllocation();
    }
    const original = localRepositoryPreparationSourceFacts(initial.facts);
    const originalBaseHash = hash({
      source: original.source,
      baseBranch: initial.facts.sourceBaseBranch ?? original.baseBranch,
      baseOid: initial.facts.sourceBaseOid ?? original.baseOid,
      objectFormat: initial.facts.source.objectFormat,
      comparisonConfig: initial.facts.source.comparisonConfig ?? {},
    });
    let baseObservation: Readonly<RepositoryObservationCapture> | undefined;
    const baseCurrent = (earlierDeadline: number) =>
      read(async (reader) => {
        if (baseObservation && reader.verifyRepositoryBaseObservation) {
          // Data witness only. The exact original factory scope must match, and
          // every call performs a new physical read under fresh owner checks.
          await reader.verifyRepositoryBaseObservation(baseObservation);
          return;
        }
        const standalone = initial.facts.layout === 'standalone';
        const access =
          reader.captureRepositoryObservation || standalone
            ? new LocalRepositoryReadAccess(reader)
            : await LocalRepositoryReadAccess.capturePreparationBase(reader, {
                version: 'preparation-base-observation-v1',
                sourceAnchor: initial.facts.source.sourceAnchor,
                gitDirectory: initial.facts.source.gitDirectory,
                commonAnchor: initial.facts.source.commonAnchor,
                deniedRoots: reader.deniedRoots,
              });
        if (reader.captureRepositoryObservation)
          await access.captureRepositoryObservation({
            mode: 'base',
            sourcePath: intent.sourcePath,
          });
        const sourceAnchor = await access.pinRoot(intent.sourcePath);
        const metadata = await inspectLocalRepositoryGitMetadata({
          path: intent.sourcePath,
          mode: reader.captureRepositoryObservation ? 'head' : 'preparation',
          readAccess: access,
          assertReadable: (path) => access.assertPath(path),
          signal: reader.signal,
          timeoutMs: Math.max(1, reader.deadline - Date.now()),
        });
        const commonAnchor = await access.pinRoot(metadata.commonDirectory);
        const { branch, head } =
          standalone && !reader.captureRepositoryObservation
            ? await readLocalRepositoryBaseReference(access, metadata, 'HEAD').then((value) => ({
                branch: value.branch,
                head: value.oid,
              }))
            : await (
                reader.captureRepositoryObservation
                  ? readLocalRepositoryGitFacts
                  : readLocalRepositoryPreparationBaseReferences
              )(metadata, {
                readAccess: access,
                signal: reader.signal,
                timeoutMs: Math.max(1, reader.deadline - Date.now()),
              });
        await access.verify();
        // Fresh original metadata/base predicates; namespace/absence stays
        // historical until the fixed publication helper's whole preflight.
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
          objectFormat: metadata.objectFormat,
          comparisonConfig: metadata.comparisonConfig ?? {},
        };
        if (hash(actual) !== originalBaseHash) throw unavailable();
        if (reader.verifyRepositoryBaseObservation)
          baseObservation = access.repositoryBaseObservation;
      }, earlierDeadline);
    return Object.freeze({
      ...original,
      allocationFacts: initial.facts,
      allocationFactsSha256: initial.factsSha256,
      publicationPackedRefs: initial.publicationPackedRefs,
      ...(objectSource ? { objectSource: Object.freeze(objectSource) } : {}),
      ...(disposeAcquired ? { dispose: disposeAcquired } : {}),
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
  } catch (error) {
    if (!(error instanceof RepositoryHostProcessUncertainError)) await disposeAcquired?.();
    throw error;
  }
}
