import { lstat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { AuthoritySnapshot } from './sandbox-authority.js';
import {
  captureNativeHostReadOwner,
  type NativeHostToolContext,
} from './native-host-tool-context.js';
import { captureNativeLocalRepositoryReader } from './local-repository-native-read.js';
import { LocalRepositoryReadAccess } from './local-repository-read-access.js';
import {
  retainPreparationPackedRefs,
  type PreparationPackedRefs,
} from './local-repository-preparation-packed-refs.js';
import {
  preparationReadDeadline,
  preparationReadStageMs,
} from './local-repository-preparation-read-policy.js';
import {
  captureLocalRepositoryPreparationObjects,
  type LocalRepositoryPreparationObjectView,
} from './local-repository-preparation-objects.js';
import type { LocalRepositoryAllocationFacts } from './local-repository-allocation-facts.js';
import {
  freezePendingHostTaskData,
  pendingHostTaskDecisionHash,
  type PendingHostTaskRequest,
} from './pending-host-task.js';

const unavailable = () => Error('Prepared private object data unavailable');
export interface LocalRepositoryPreparationObjectData {
  readonly context: NativeHostToolContext;
  readonly requestSha256: string;
  readonly factsSha256: string;
  readonly source: LocalRepositoryAllocationFacts['source'];
  readonly baseOid: string;
  readonly objectFormat: string;
  readonly deadline: number;
  readonly view: LocalRepositoryPreparationObjectView;
  readonly publicationPackedRefs: PreparationPackedRefs;
  dispose(): Promise<void>;
}
function ownedDisposer(
  artifact: Awaited<ReturnType<typeof captureLocalRepositoryPreparationObjects>>,
) {
  const action = artifact.dispose;
  // This closure retains ONLY independently owned scratch custody/data. It has
  // no read owner, context, permission success or disposed reader environment.
  return Object.freeze(async () => {
    try {
      const pending: unknown = Reflect.apply(action, artifact, []);
      if (!(pending instanceof Promise) || (await pending) !== undefined) throw unavailable();
    } catch {
      throw unavailable();
    }
  });
}
/** PRE-APPROVAL READ only. This never approves source Git effects. Every pending
 * capture joins before reader disposal or scratch cleanup, even if cancellation
 * arrives before the capture result/disposer assignment completes. */
export async function captureLocalRepositoryPreparationObjectData(
  context: NativeHostToolContext,
  request: Readonly<PendingHostTaskRequest>,
  facts: LocalRepositoryAllocationFacts,
  factsSha256: string,
  deadline: number,
  originalPackedRefs: unknown,
  objectSource?: import('./local-repository-git-inspection.js').LocalRepositoryGitMetadata,
): Promise<Readonly<LocalRepositoryPreparationObjectData>> {
  const publicationPackedRefs = retainPreparationPackedRefs(originalPackedRefs);
  const originalFacts = freezePendingHostTaskData(structuredClone(facts));
  const requestSha256 = pendingHostTaskDecisionHash(request);
  const owner = captureNativeHostReadOwner(context);
  if (
    !owner ||
    !Number.isSafeInteger(deadline) ||
    deadline <= Date.now() ||
    deadline > Date.now() + 300000 ||
    pendingHostTaskDecisionHash(originalFacts) !== factsSha256
  )
    throw unavailable();
  const current = () => {
    context.signal.throwIfAborted();
    if (Date.now() >= deadline) throw unavailable();
    owner.assertCurrentSync();
  };
  let reader: Awaited<ReturnType<typeof captureNativeLocalRepositoryReader>> | undefined;
  let creation: ReturnType<typeof captureLocalRepositoryPreparationObjects> | undefined;
  let artifact: Awaited<ReturnType<typeof captureLocalRepositoryPreparationObjects>> | undefined;
  const joinCapture = async () => {
    if (creation) {
      const [result] = await Promise.allSettled([creation]);
      if (result.status === 'fulfilled') artifact ??= result.value;
    }
  };
  try {
    current();
    await owner.assertCurrent();
    current();
    reader = await captureNativeLocalRepositoryReader(context, {
      deadline: preparationReadDeadline(deadline, context.signal),
    });
    try {
      const access = new LocalRepositoryReadAccess(reader);
      const source = await access.pinRoot(originalFacts.source.path);
      const common = await access.pinRoot(originalFacts.source.commonDirectory);
      if (
        !isDeepStrictEqual(source.identity, originalFacts.source.sourceAnchor.identity) ||
        !isDeepStrictEqual(common.identity, originalFacts.source.commonAnchor.identity)
      )
        throw unavailable();
      current();
      if (objectSource) {
        await access.pinRoot(objectSource.path);
        await access.pinRoot(objectSource.commonDirectory);
      }
      creation = captureLocalRepositoryPreparationObjects(objectSource ?? originalFacts.source, {
        readAccess: access,
        baseOid: originalFacts.baseOid,
        signal: reader.signal,
        timeoutMs: Math.max(
          1,
          Math.min(preparationReadStageMs, deadline - Date.now(), reader.deadline - Date.now()),
        ),
      });
      artifact = await creation;
      await access.verify();
      current();
    } finally {
      await joinCapture();
      try {
        await reader.dispose();
      } finally {
        await owner.assertCurrent();
        current();
      }
    }
    if (!artifact) throw unavailable();
    const view = freezePendingHostTaskData(structuredClone(artifact.view));
    const values = {
      context,
      requestSha256,
      factsSha256,
      source: freezePendingHostTaskData(structuredClone(originalFacts.source)),
      baseOid: originalFacts.baseOid,
      objectFormat: originalFacts.source.objectFormat,
      deadline,
      view,
      publicationPackedRefs,
      dispose: ownedDisposer(artifact),
    };
    current();
    return Object.freeze(
      Object.defineProperties(
        {},
        Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }])),
      ),
    ) as LocalRepositoryPreparationObjectData;
  } catch {
    await joinCapture();
    if (artifact) await ownedDisposer(artifact)();
    throw unavailable();
  }
}
function property(input: unknown, key: string): unknown {
  if (!input || typeof input !== 'object' || !Object.isFrozen(input)) throw unavailable();
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (
    !descriptor ||
    !('value' in descriptor) ||
    descriptor.enumerable ||
    descriptor.configurable ||
    descriptor.writable
  )
    throw unavailable();
  return descriptor.value;
}
async function privateIdentities(scratch: string) {
  const [root, parent] = await Promise.allSettled([
    lstat(scratch, { bigint: true }),
    lstat(dirname(scratch), { bigint: true }),
  ]);
  if (root.status !== 'fulfilled' || parent.status !== 'fulfilled') throw unavailable();
  return [root.value, parent.value] as const;
}
/** Data correlation and physical OWNED-private inputs only. The actor must run
 * the ORIGINAL consumed full/current operation before calling; these bytes or
 * historical identities never grant task/source access or prove task custody. */
export async function verifyLocalRepositoryPreparationObjectData(
  input: unknown,
  context: NativeHostToolContext,
  requestSha256: string,
  facts: LocalRepositoryAllocationFacts,
  factsSha256: string,
  originalPackedRefs: unknown,
): Promise<LocalRepositoryPreparationObjectView> {
  if (
    property(input, 'publicationPackedRefs') !== retainPreparationPackedRefs(originalPackedRefs) ||
    property(input, 'context') !== context ||
    property(input, 'requestSha256') !== requestSha256 ||
    property(input, 'factsSha256') !== factsSha256 ||
    property(input, 'baseOid') !== facts.baseOid ||
    property(input, 'objectFormat') !== facts.source.objectFormat ||
    !isDeepStrictEqual(property(input, 'source'), facts.source) ||
    pendingHostTaskDecisionHash(facts) !== factsSha256
  )
    throw unavailable();
  const deadline = property(input, 'deadline');
  if (typeof deadline !== 'number' || !Number.isSafeInteger(deadline) || Date.now() >= deadline)
    throw unavailable();
  context.signal.throwIfAborted();
  const keys = [
    'context',
    'requestSha256',
    'factsSha256',
    'source',
    'baseOid',
    'objectFormat',
    'deadline',
    'view',
    'dispose',
    'publicationPackedRefs',
  ];
  if (
    Reflect.ownKeys(input as object).length !== keys.length ||
    Reflect.ownKeys(input as object).some((key) => typeof key !== 'string' || !keys.includes(key))
  )
    throw unavailable();
  const view = property(input, 'view') as LocalRepositoryPreparationObjectView;
  if (
    !view ||
    !Object.isFrozen(view) ||
    view.coverage !== 'preparation-required-objects-v1' ||
    view.baseOid !== facts.baseOid
  )
    throw unavailable();
  if (
    !isAbsolute(view.scratch) ||
    resolve(view.scratch) !== view.scratch ||
    view.scratch === '/' ||
    view.gitDirectory !== join(view.scratch, 'git-admin') ||
    !Array.isArray(view.privateAuthority) ||
    view.privateAuthority.length > 5000
  )
    throw unavailable();
  for (const entry of view.privateAuthority) {
    if (
      !entry ||
      typeof entry.path !== 'string' ||
      !(entry.path === view.scratch || entry.path.startsWith(view.scratch + '/')) ||
      resolve(entry.path) !== entry.path ||
      !entry.stat ||
      !/^[0-9]{1,32}$/.test(entry.stat.dev) ||
      !/^[0-9]{1,32}$/.test(entry.stat.ino) ||
      !/^[0-9]{1,32}$/.test(entry.stat.mode) ||
      (entry.digest !== undefined && !/^[a-f0-9]{64}$/.test(entry.digest))
    )
      throw unavailable();
  }
  const same = (actual: { dev: bigint; ino: bigint }, expected: { dev: string; ino: string }) =>
    String(actual.dev) === expected.dev && String(actual.ino) === expected.ino;
  const [root, parent] = await privateIdentities(view.scratch);
  if (
    !root.isDirectory() ||
    !parent.isDirectory() ||
    !same(root, view.scratchIdentity) ||
    !same(parent, view.scratchParentIdentity)
  )
    throw unavailable();
  context.signal.throwIfAborted();
  // Only already-owned private paths; the unchanged staging worker repeats its
  // own identities/config/content fences across wrapping and actual spawn.
  AuthoritySnapshot.restore(view.privateAuthority).verify();
  const [after, ancestor] = await privateIdentities(view.scratch);
  if (
    !after.isDirectory() ||
    !ancestor.isDirectory() ||
    !same(after, view.scratchIdentity) ||
    !same(ancestor, view.scratchParentIdentity)
  )
    throw unavailable();
  context.signal.throwIfAborted();
  return view;
}
