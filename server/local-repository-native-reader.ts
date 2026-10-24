import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { NativeBaseReadScope } from './codex-conversation.js';
import type { PreparedRepositoryBarrierReadScope } from './prepared-repository-barrier-read.js';
import type { LocalRepositoryReadAuthority } from './local-repository-read-access.js';
import { AuthoritySnapshot } from './sandbox-authority.js';
import { executeSandboxedCommand } from './sandboxed-command.js';
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

const unavailable = () => Error('Local repository native reads unavailable');
type NativeReaderPathAuthorization = Readonly<{
  reader: LocalRepositoryReadAuthority;
  assertReadable: LocalRepositoryReadAuthority['assertReadable'];
  assertCurrentSync: NonNullable<LocalRepositoryReadAuthority['assertCurrentSync']>;
}>;
// Provenance only, never a retained authorization result. The registered entry
// starts with the full fresh original-owner fence before any path effect/await.
const nativePathAuthorizations = new WeakMap<object, NativeReaderPathAuthorization>();
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
        const result = await executeSandboxedCommand({
          command: request.command,
          cwd: directory,
          writableRoots: [directory],
          deniedRoots: [...exclusions],
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
  const reader: LocalRepositoryReadAuthority & { dispose(): Promise<void> } = {
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
  nativePathAuthorizations.set(
    reader,
    Object.freeze({
      reader,
      assertReadable: reader.assertReadable,
      assertCurrentSync: current,
    }),
  );
  return reader;
}
