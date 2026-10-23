import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { NativeBaseReadScope } from './codex-conversation.js';
import type { NativeHostToolContext } from './native-host-tool-context.js';
import type { LocalRepositoryReadAuthority } from './local-repository-read-access.js';
import { AuthoritySnapshot } from './sandbox-authority.js';
import { executeSandboxedCommand } from './sandboxed-command.js';
import {
  captureNativeReadAnchor,
  executeNativeAnchoredReadOperation,
  freezeNativeReadExclusions,
  type NativeFileHelperTransport,
} from './native-file-operation.js';

const unavailable = () => Error('Local repository native reads unavailable');
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

/** Private original-command composition, never a tool, registry or grant. The
 * existing SRT default-read boundary is qualified ONLY for an actual '/' base.
 * Narrow owners fail before source lookup; every helper uses that same boundary. */
export async function captureNativeLocalRepositoryReader(
  context: NativeHostToolContext,
  options: { deadline: number },
): Promise<LocalRepositoryReadAuthority & { dispose(): Promise<void> }> {
  const scope: NativeBaseReadScope | undefined = context.nativeBaseReadScope;
  const deadline = options.deadline;
  let disposed = false;
  let closing: Promise<void> | undefined;
  const abort = new AbortController();
  const signal = AbortSignal.any([context.signal, abort.signal]);
  const current = () => {
    signal.throwIfAborted();
    if (disposed || Date.now() >= deadline) throw unavailable();
    context.assertCurrentSync();
    if (!scope) throw unavailable();
    scope.assertCurrentSync();
  };
  current();
  if (process.platform !== 'darwin') throw unavailable();
  if (!Number.isSafeInteger(deadline) || deadline > Date.now() + 30000) throw unavailable();
  if (![...scope!.readableRoots, ...scope!.workspaceRoots].includes('/')) throw unavailable();
  const deniedRoots = freezeNativeReadExclusions(scope!.deniedRoots);
  const authorize = async (path: string) => {
    current();
    if (!canonicalPath(path) || deniedRoots.some((root) => contains(root, path)))
      throw unavailable();
    await context.assertCurrent();
    current();
  };
  // This is the existing private operation-scratch pattern. No source, parent or
  // Git metadata is a writeroot; policy and environment validators stay intact.
  let scratch: string | undefined;
  const custody = new AuthoritySnapshot();
  try {
    await context.assertCurrent();
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
            await context.assertCurrent();
            current();
          },
          beforeSpawn: () => {
            current();
            custody.verify();
          },
        });
        current();
        request.signal.throwIfAborted();
        await context.assertCurrent();
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
  const reader: LocalRepositoryReadAuthority & { dispose(): Promise<void> } = {
    deniedRoots,
    signal,
    deadline,
    assertReadable: authorize,
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
      } catch {
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
  return Object.freeze(reader);
}
