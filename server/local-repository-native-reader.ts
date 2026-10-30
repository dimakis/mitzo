import {
  captureRepositoryObservation,
  verifyRepositoryObservation,
  freezeRepositoryObservationPlan,
  type RepositoryObservationCapture,
  type RepositoryObservationInput,
} from './native-repository-observation.js';
import {
  preparationObjectStoreCommand,
  parsePreparationObjectStoreCapture,
  type PreparationObjectStoreCapture,
} from './native-repository-object-store.js';
import { localRepositoryReadDirectoryExclusionNames } from './local-repository-read-exclusions.js';
import { mkdtemp, realpath, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { NativeBaseReadScope } from './codex-conversation.js';
import type { PreparedRepositoryBarrierReadScope } from './prepared-repository-barrier-read.js';
import type { LocalRepositoryReadAuthority } from './local-repository-read-access.js';
import { AuthoritySnapshot } from './sandbox-authority.js';
import {
  executeSandboxedCommand,
  executePrivateRepositoryObservation,
} from './sandboxed-command.js';
import {
  captureNativeReadAnchor,
  executeNativeAnchoredReadOperation,
  executeNativeDirectoryVerificationBatch,
  freezeNativeDirectoryVerificationInputs,
  freezeNativeReadExclusions,
  NativeReadAnchorMissingError,
  type NativeFileHelperTransport,
} from './native-file-operation.js';

import {
  captureNativePreparationObservation,
  verifyNativePreparationObservation,
  freezeNativePreparationObservationPlan,
  type NativePreparationObservationCapture,
  type NativePreparationObservationPlan,
  type NativePreparationObservationScratch,
} from './native-preparation-observation.js';
import { preparedTopologyInput } from './native-repository-topology.js';
import type { RepositoryTaskCheckout } from './repository-task-checkout.js';

const unavailable = () => Error('Local repository native reads unavailable');
type NativeReaderPathAuthorization = Readonly<{
  reader: LocalRepositoryReadAuthority;
  assertReadable: LocalRepositoryReadAuthority['assertReadable'];
  assertCurrentSync: NonNullable<LocalRepositoryReadAuthority['assertCurrentSync']>;
}>;
// Provenance only, never a retained authorization result. The registered entry
// starts with the full fresh original-owner fence before any path effect/await.
const nativePathAuthorizations = new WeakMap<object, NativeReaderPathAuthorization>();
const repositoryBaseCaptures = new WeakMap<object, object>();
type NativeTopologyAssertion = (
  task: Readonly<RepositoryTaskCheckout>,
  sourceGitDirectory: string,
) => Promise<void>;
const nativeTopologyAssertions = new WeakMap<object, NativeTopologyAssertion>();
/** Factory provenance only. Every call starts a fresh owned physical phase;
 * an assertion result is never retained or accepted from a caller. */
export function captureNativeTopologyAssertion(reader: LocalRepositoryReadAuthority) {
  const assertion = nativeTopologyAssertions.get(reader);
  if (!assertion) return;
  const descriptor = Object.getOwnPropertyDescriptor(reader, 'assertPreparedTaskTopology');
  if (
    !Object.isFrozen(reader) ||
    !descriptor ||
    !('value' in descriptor) ||
    descriptor.value !== assertion ||
    descriptor.enumerable ||
    descriptor.configurable ||
    descriptor.writable ||
    !Object.isFrozen(assertion)
  )
    throw unavailable();
  return assertion;
}
const nativeObservationReaders = new WeakMap<
  object,
  (capture: Readonly<RepositoryObservationCapture>, path: string) => void
>();
/** Parsing immutable captured data causes no filesystem effect. Only the exact
 * factory reader can supply this facet for its own capture. Full owner checks
 * remain at capture, physical verification and outward use. */
export function captureNativeObservationParser(
  reader: LocalRepositoryReadAuthority,
  capture: Readonly<RepositoryObservationCapture>,
) {
  const parse = nativeObservationReaders.get(reader);
  if (!parse || !captureNativeReaderPathAuthorization(reader)) return;
  parse(capture, capture.plan.sourcePath);
  return (path: string) => parse(capture, path);
}
export function captureNativeReaderPathAuthorization(
  reader: LocalRepositoryReadAuthority,
): NativeReaderPathAuthorization | undefined {
  const captured = nativePathAuthorizations.get(reader);
  if (!captured) return;
  if (!Object.isFrozen(reader)) throw unavailable();
  for (const [key, original] of [
    ['assertReadable', captured.assertReadable],
    ['assertCurrentSync', captured.assertCurrentSync],
  ] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(reader, key);
    if (
      !descriptor ||
      !('value' in descriptor) ||
      descriptor.value !== original ||
      descriptor.enumerable ||
      descriptor.configurable ||
      descriptor.writable ||
      !Object.isFrozen(original)
    )
      throw unavailable();
  }
  return captured;
}
const contains = (root: string, path: string) => {
  const child = relative(root, path);
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
};
const canonicalPath = (path: string) =>
  typeof path === 'string' &&
  isAbsolute(path) &&
  resolve(path) === path &&
  !path.includes('\0') &&
  Buffer.byteLength(path) <= 4096 &&
  path.split('/').length <= 129;

/** Physical reader implementation only. Its private registry can identify only
 * readers constructed here; native context and completed-turn owners stay in
 * their original wrappers and are freshly asserted by every reader entry. */
export async function captureLocalRepositoryReader(
  scope: NativeBaseReadScope | PreparedRepositoryBarrierReadScope | undefined,
  ownerSignal: AbortSignal,
  assertCurrentSync: () => void,
  revalidate: () => Promise<void>,
  options: { deadline: number },
): Promise<LocalRepositoryReadAuthority & { dispose(): Promise<void> }> {
  const deadline = options.deadline;
  let disposed = false;
  let closing: Promise<void> | undefined;
  const abort = new AbortController();
  const signal = AbortSignal.any([ownerSignal, abort.signal]);
  const current = () => {
    signal.throwIfAborted();
    if (disposed || Date.now() >= deadline) throw unavailable();
    assertCurrentSync();
    if (!scope) throw unavailable();
  };
  current();
  if (process.platform !== 'darwin') throw unavailable();
  if (!Number.isSafeInteger(deadline) || deadline > Date.now() + 60000) throw unavailable();
  if (![...scope!.readableRoots, ...scope!.workspaceRoots].includes('/')) throw unavailable();
  const deniedRoots = freezeNativeReadExclusions(scope!.deniedRoots);
  const authorize = async (path: string) => {
    current();
    if (!canonicalPath(path) || deniedRoots.some((root) => contains(root, path)))
      throw unavailable();
    // Logical/cached observations require the current exact policy and owner,
    // not another physical-owner wait. Every real helper independently awaits
    // revalidation before spawn and after its result, under the same deadline.
  };
  // This is the existing private operation-scratch pattern. No source, parent or
  // Git metadata is a writeroot; policy and environment validators stay intact.
  let scratch: string | undefined;
  const custody = new AuthoritySnapshot();
  try {
    await revalidate();
    current();
    scratch = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-native-read-')));
    current();
    if (deniedRoots.some((root) => contains(root, scratch!))) throw unavailable();
    custody.capture(scratch);
    custody.verify();
  } catch {
    if (scratch) await rm(scratch, { recursive: true, force: true });
    throw unavailable();
  }
  const directory = scratch;
  const pending = new Set<Promise<unknown>>();
  const transport =
    (exclusions: readonly string[]): NativeFileHelperTransport =>
    async (request) => {
      const run = async () => {
        current();
        request.signal.throwIfAborted();
        custody.verify();
        const input = JSON.parse(request.requestJson);
        const observation = [
          'CaptureRepositoryObservation',
          'VerifyRepositoryObservation',
        ].includes(input.operation);
        const run = observation ? executePrivateRepositoryObservation : executeSandboxedCommand;
        const result = await run({
          requestJson: request.requestJson,
          command: request.command,
          cwd: directory,
          writableRoots: [directory],
          deniedRoots: observation ? [...input.repositoryPlan.deniedRoots] : [...exclusions],
          // Omission is justified by this original immutable '/' scope ONLY.
          env: { PATH: '/usr/bin:/bin' },
          signal: request.signal,
          privateOutput: 'separate',
          timeoutMs: Math.max(1, Math.min(request.timeoutMs, deadline - Date.now())),
          maxOutputBytes: request.maxOutputBytes,
          beforeSpawnAsync: async () => {
            await revalidate();
            current();
          },
          beforeSpawn: () => {
            current();
            custody.verify();
          },
        });
        current();
        request.signal.throwIfAborted();
        await revalidate();
        current();
        custody.verify();
        if (typeof result.stdout !== 'string') throw unavailable();
        return { stdout: result.stdout, isError: result.isError };
      };
      const operation = run();
      pending.add(operation);
      try {
        return await operation;
      } finally {
        pending.delete(operation);
      }
    };
  const scratchIdentity = custody.serialize().find((item) => item.path === directory)?.stat;
  if (!scratchIdentity) throw unavailable();
  let observationSequence = 0;
  const observations = new WeakMap<
    Readonly<NativePreparationObservationCapture>,
    Readonly<{
      plan: NativePreparationObservationPlan;
      scratch: NativePreparationObservationScratch;
    }>
  >();
  const repositoryCaptures = new WeakSet<object>();
  const objectStores = new WeakMap<object, Parameters<typeof preparationObjectStoreCommand>[0]>();
  const reader: LocalRepositoryReadAuthority & { dispose(): Promise<void> } = {
    assertPreparedTaskTopology: Object.freeze(
      async (task: Readonly<RepositoryTaskCheckout>, sourceGitDirectory: string) => {
        current();
        const input = preparedTopologyInput(task, sourceGitDirectory);
        const plan = freezeRepositoryObservationPlan({
          ...input,
          version: 'repository-read-v1',
          deniedRoots,
          excludedNames: [...localRepositoryReadDirectoryExclusionNames],
        });
        await captureRepositoryObservation(
          plan,
          signal,
          Math.max(1, Math.min(30000, deadline - Date.now())),
          transport(deniedRoots),
        );
        current();
      },
    ),
    capturePreparationObjectStore: async (source, objectFormat) => {
      await authorize(source.rootPath);
      await revalidate();
      current();
      custody.verify();
      const rootPath = await mkdtemp(join(directory, 'objects-'));
      const info = await lstat(rootPath, { bigint: true });
      custody.capture(rootPath);
      custody.verify();
      current();
      const target = Object.freeze({
        rootPath,
        identity: Object.freeze({ dev: String(info.dev), ino: String(info.ino) }),
      });
      const plan = {
        version: 'preparation-object-store-v1',
        source,
        target,
        objectFormat,
        deniedRoots,
      };
      const input = { operation: 'capture', plan };
      const result = await transport(deniedRoots)({
        command: preparationObjectStoreCommand(input),
        requestJson: JSON.stringify({ operation: 'CapturePreparationObjectStore' }),
        signal,
        timeoutMs: Math.max(1, Math.min(30000, deadline - Date.now())),
        maxOutputBytes: 4 * 1024 * 1024,
      });
      current();
      if (result.isError) throw unavailable();
      const captured = parsePreparationObjectStoreCapture(JSON.parse(result.stdout), target);
      objectStores.set(captured, plan);
      return captured;
    },
    verifyPreparationObjectStore: async (captured: Readonly<PreparationObjectStoreCapture>) => {
      current();
      const plan = objectStores.get(captured);
      if (!plan) throw unavailable();
      const input = { operation: 'verify', plan, digest: captured.digest };
      const result = await transport(deniedRoots)({
        command: preparationObjectStoreCommand(input),
        requestJson: JSON.stringify({ operation: 'VerifyPreparationObjectStore' }),
        signal,
        timeoutMs: Math.max(1, Math.min(30000, deadline - Date.now())),
        maxOutputBytes: 32768,
      });
      if (result.isError) throw unavailable();
      const value = JSON.parse(result.stdout);
      if (value.verified !== true || Object.keys(value).length !== 1) throw unavailable();
      current();
    },
    captureRepositoryObservation: async (input: RepositoryObservationInput) => {
      current();
      await authorize(input.sourcePath);
      if (input.taskRoot) await authorize(input.taskRoot);
      const plan = freezeRepositoryObservationPlan({
        mode: input.mode,
        sourcePath: input.sourcePath,
        ...(input.taskRoot ? { taskRoot: input.taskRoot } : {}),
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        version: 'repository-read-v1',
        readableRoots: input.readableRoots ?? ['/'],
        deniedRoots: [...new Set([...deniedRoots, ...(input.additionalDeniedRoots ?? [])])],
        excludedNames: [...localRepositoryReadDirectoryExclusionNames],
      });
      const captured = await captureRepositoryObservation(
        plan,
        signal,
        Math.max(1, Math.min(30000, deadline - Date.now())),
        transport(deniedRoots),
      );
      current();
      repositoryCaptures.add(captured);
      if (plan.mode === 'base') repositoryBaseCaptures.set(captured, scope!);
      return captured;
    },
    verifyRepositoryBaseObservation: async (captured) => {
      current();
      if (
        repositoryBaseCaptures.get(captured) !== scope ||
        captured.plan.mode !== 'base' ||
        JSON.stringify(captured.plan.deniedRoots) !== JSON.stringify(deniedRoots) ||
        JSON.stringify(captured.plan.readableRoots) !== JSON.stringify(['/'])
      )
        throw unavailable();
      await verifyRepositoryObservation(
        captured.plan,
        captured.digest,
        signal,
        Math.max(1, Math.min(30000, deadline - Date.now())),
        transport(deniedRoots),
      );
      current();
    },
    verifyRepositoryObservation: async (captured) => {
      current();
      if (!repositoryCaptures.has(captured)) throw unavailable();
      await verifyRepositoryObservation(
        captured.plan,
        captured.digest,
        signal,
        Math.max(1, Math.min(30000, deadline - Date.now())),
        transport(deniedRoots),
      );
      current();
    },
    deniedRoots,
    signal,
    deadline,
    assertCurrentSync: Object.freeze(current),
    assertReadable: Object.freeze(authorize),
    revalidate: async () => {
      current();
      await revalidate();
      current();
    },
    captureReadAnchor: async (path: string) => {
      try {
        await authorize(path);
        const anchor = await captureNativeReadAnchor(
          { file_path: path, deniedRoots },
          signal,
          Math.max(1, Math.min(30000, deadline - Date.now())),
          transport(deniedRoots),
        );
        await authorize(path);
        return anchor;
      } catch (error) {
        try {
          await revalidate();
          await authorize(path);
        } catch {
          throw unavailable();
        }
        if (error instanceof NativeReadAnchorMissingError) throw error;
        throw unavailable();
      }
    },
    executeReadOperation: async (request, operationSignal, timeoutMs) => {
      try {
        current();
        operationSignal.throwIfAborted();
        await authorize(request.file_path);
        const exclusions = freezeNativeReadExclusions([
          ...new Set([...deniedRoots, ...freezeNativeReadExclusions(request.deniedRoots)]),
        ]);
        const result = await executeNativeAnchoredReadOperation(
          { ...request, deniedRoots: exclusions },
          AbortSignal.any([signal, operationSignal]),
          Math.max(1, Math.min(timeoutMs, deadline - Date.now())),
          transport(exclusions),
        );
        operationSignal.throwIfAborted();
        await authorize(request.file_path);
        return result;
      } catch {
        throw unavailable();
      }
    },
    executeDirectoryVerification: async (requests, operationSignal, timeoutMs) => {
      try {
        current();
        operationSignal.throwIfAborted();
        const captured = freezeNativeDirectoryVerificationInputs(requests);
        const exclusions = freezeNativeReadExclusions([
          ...new Set([
            ...deniedRoots,
            ...captured.flatMap((request) => [...freezeNativeReadExclusions(request.deniedRoots)]),
          ]),
        ]);
        const items = [];
        for (const request of captured) {
          if (
            request.operation !== 'ListDirectory' ||
            request.prefix !== undefined ||
            request.expectedState !== undefined
          )
            throw unavailable();
          await authorize(request.file_path);
          items.push({
            operation: 'ListDirectory' as const,
            file_path: request.file_path,
            rootAnchor: request.rootAnchor,
            parentIdentity: request.parentIdentity,
            identity: request.identity,
            limit: request.limit,
            maxEntries: request.maxEntries,
            maxNameBytes: request.maxNameBytes,
          });
        }
        const result = await executeNativeDirectoryVerificationBatch(
          { operation: 'ListDirectoryBatch', deniedRoots: exclusions, items },
          AbortSignal.any([signal, operationSignal]),
          Math.max(1, Math.min(timeoutMs, deadline - Date.now())),
          transport(exclusions),
        );
        operationSignal.throwIfAborted();
        for (const request of captured) await authorize(request.file_path);
        return result;
      } catch {
        throw unavailable();
      }
    },
    capturePreparationObservation: async (input) => {
      current();
      const projected = freezeNativePreparationObservationPlan(input);
      const plan = freezeNativePreparationObservationPlan({
        ...projected,
        deniedRoots: freezeNativeReadExclusions([
          ...new Set([...deniedRoots, ...projected.deniedRoots]),
        ]),
      });
      for (const path of [
        plan.sourceAnchor.rootPath,
        plan.gitDirectory,
        plan.commonAnchor.rootPath,
      ])
        await authorize(path);
      if (observationSequence >= 1) throw unavailable();
      const scratch = Object.freeze({
        rootAnchor: Object.freeze({
          rootPath: directory,
          identity: Object.freeze({ dev: scratchIdentity.dev, ino: scratchIdentity.ino }),
        }),
        file_path: join(directory, `capture-${observationSequence++}.json`),
      });
      const captured = await captureNativePreparationObservation(
        plan,
        scratch,
        signal,
        Math.max(1, Math.min(30000, deadline - Date.now())),
        transport(plan.deniedRoots),
      );
      current();
      observations.set(captured, Object.freeze({ plan, scratch }));
      return captured;
    },
    verifyPreparationObservation: async (captured) => {
      current();
      const held = observations.get(captured);
      if (!held) throw unavailable();
      for (const path of [
        held.plan.sourceAnchor.rootPath,
        held.plan.gitDirectory,
        held.plan.commonAnchor.rootPath,
      ])
        await authorize(path);
      await verifyNativePreparationObservation(
        held.plan,
        held.scratch,
        captured.witness,
        signal,
        Math.max(1, Math.min(30000, deadline - Date.now())),
        transport(held.plan.deniedRoots),
      );
      current();
    },
    dispose: () => {
      if (!closing) {
        disposed = true;
        // Retain the promise before abort dispatches synchronous listeners.
        // Every concurrent/reentrant caller joins the same complete cleanup.
        closing = Promise.resolve().then(async () => {
          await Promise.allSettled([...pending]);
          try {
            custody.verify();
            await rm(directory, { recursive: true, force: true });
          } catch {
            throw unavailable();
          }
        });
        abort.abort();
      }
      return closing;
    },
  };
  // Keep the original owner scope, exclusions and private lifetime ports out of
  // accidental JSON/spread projection into a model result or prompt.
  for (const name of Object.keys(reader))
    Object.defineProperty(reader, name, { enumerable: false });
  Object.freeze(reader);
  nativeTopologyAssertions.set(reader, reader.assertPreparedTaskTopology!);
  nativePathAuthorizations.set(
    reader,
    Object.freeze({
      reader,
      assertReadable: reader.assertReadable,
      assertCurrentSync: current,
    }),
  );
  nativeObservationReaders.set(reader, (capture, path) => {
    signal.throwIfAborted();
    if (
      disposed ||
      Date.now() >= deadline ||
      !repositoryCaptures.has(capture) ||
      !canonicalPath(path) ||
      !capture.plan.readableRoots.some((root) => contains(root, path)) ||
      capture.plan.deniedRoots.some((root) => contains(root, path))
    )
      throw unavailable();
  });
  return reader;
}
