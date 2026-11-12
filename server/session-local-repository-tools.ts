import {
  codexToolFailureResult,
  CodexToolFailure,
  withCodexToolCleanup,
} from './codex-tool-failure.js';
import { createLogger } from './logger.js';
import {
  freezeNativeReadExclusions,
  type NativeAnchoredReadRequest,
  type executeNativeAnchoredReadOperation,
} from './native-file-operation.js';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, sep } from 'node:path';
import type { ToolDefinition } from '@mitzo/harness';
import { z } from 'zod';
import {
  captureNativeHostReadOwner,
  type NativeHostReadOwner,
  type NativeHostToolContext,
} from './native-host-tool-context.js';
import {
  discoverLocalRepository,
  inspectLocalRepository,
  type LocalRepositoryLimits,
  type LocalRepositoryReadScope,
} from './local-repository-discovery.js';
import type { LocalRepositoryReadAnchor } from './local-repository-read-access.js';
import type { captureNativeLocalRepositoryReader } from './local-repository-native-read.js';
import { nativeRepositoryReadCleanupSettled } from './local-repository-native-reader.js';
import { retainCallbackOutcome } from './turn-callbacks.js';
import { LocalRepositoryGitInspectionError } from './local-repository-git-inspection.js';

export const LOCAL_REPOSITORY_TOOL_INSTRUCTIONS =
  'For existing Local Mac repositories, use DiscoverLocalRepository with a name or explicit path, then InspectLocalRepository to read instructions and working-tree facts. Discovery is bounded by current read access; orientation hints are not enrollment or a filesystem boundary. Show the chosen location and allow override. Ask for a choice only for ambiguous candidates, or missing source/destination details when absent. These read tools do not materialize a workspace or grant native access.';

export const localRepositoryToolSchemas = {
  DiscoverLocalRepository: z.strictObject({
    query: z.string().trim().min(1).max(256).optional(),
    path: z.string().min(1).max(4096).optional(),
  }),
  InspectLocalRepository: z.strictObject({ path: z.string().min(1).max(4096) }),
};
const descriptions = {
  DiscoverLocalRepository:
    'Find an existing Mac repository in bounded, currently readable locations. Supply a repository name or an explicit path override. Returns selected, ambiguous, missing or access-required facts without enrollment or acquisition.',
  InspectLocalRepository:
    'Read an existing Mac repository’s applicable instructions, dirty state and Git/worktree facts within current access. Preserves source work and reports incomplete inspection explicitly.',
};
export const localRepositoryToolDefinitions: ToolDefinition[] = Object.entries(
  localRepositoryToolSchemas,
).map(([name, schema]) => ({
  name,
  description: descriptions[name as keyof typeof descriptions],
  input_schema: z.toJSONSchema(schema),
}));

export interface LocalRepositoryReadPolicy {
  /** Actual owner projection, including canonical denials and lexical aliases.
   * Mode, profile instructions and repository files cannot supply this scope. */
  accessScope: LocalRepositoryReadScope;
  discoveryRoots: readonly string[];
  repositoryCatalog?: Readonly<Record<string, string>>;
  orientationHints?: readonly string[];
  limits?: LocalRepositoryLimits;
  assertCurrentSync(): void;
}
export interface SessionLocalRepositoryToolOwner {
  /** Complete exclusions from the original actual read scope, not tool intent. */
  captureReadExclusions(
    context: NativeHostToolContext,
    signal: AbortSignal,
  ): Promise<readonly string[]>;
  /** Invoke captureNativeHostToolContext inside the original verified native
   * callback, before parsing tool intent. Never reconstruct it from tool JSON. */
  capture(name: string, input: Record<string, unknown>, signal: AbortSignal): NativeHostToolContext;
  /** Qualified current permission owner only; this observation grants nothing. */
  readPolicy(
    context: NativeHostToolContext,
    signal: AbortSignal,
  ): Promise<LocalRepositoryReadPolicy>;
  /** Qualified owner-captured immutable filesystem anchor, never model intent. */
  captureReadAnchor(
    context: NativeHostToolContext,
    path: string,
    signal: AbortSignal,
  ): Promise<LocalRepositoryReadAnchor>;
  /** Original qualified native transport, retained with its original current fences. */
  executeReadOperation(
    context: NativeHostToolContext,
    request: NativeAnchoredReadRequest,
    signal: AbortSignal,
    timeoutMs: number,
  ): ReturnType<typeof executeNativeAnchoredReadOperation>;
  /** Existing actual path authority, rechecked as an additional ceiling. */
  assertPathAccess(
    context: NativeHostToolContext,
    path: string,
    signal: AbortSignal,
  ): Promise<void>;
}

/** Production composition accepts only the original reader factory. The older
 * explicit ports remain a generic offline-fixture contract, never a fallback
 * after this factory refuses current native authority. */
export interface NativeSessionLocalRepositoryToolOwner extends Pick<
  SessionLocalRepositoryToolOwner,
  'capture' | 'readPolicy'
> {
  captureReader: typeof captureNativeLocalRepositoryReader;
}

/** Pure immutable union reduction for the genuine native read projection only.
 * Denials and original policy/target identities remain separate and unchanged. */
export function nativeRepositoryReadRootUnion(roots: readonly string[]): readonly string[] {
  const unique = [...new Set(roots)];
  return Object.freeze(
    unique.filter(
      (path) =>
        !unique.some((root) => {
          if (root === path) return false;
          const rest = relative(root, path);
          return !isAbsolute(rest) && rest !== '..' && !rest.startsWith(`..${sep}`);
        }),
    ),
  );
}

function assertSynchronous(assertion: () => unknown) {
  const result = assertion();
  if (result === undefined) return;
  void Promise.resolve(result).catch((error: unknown) => {
    const projected = JSON.parse(codexToolFailureResult(error, false).content);
    createLogger('local-repository-tools').warn(
      'Asynchronous repository owner assertion rejected',
      {
        diagnosticId: projected.diagnosticId,
        toolFailureCode: projected.error,
        diagnostic: projected.diagnostic,
      },
    );
  });
  throw Error('Current local repository owner required');
}
const unavailable = () => codexToolFailureResult(new CodexToolFailure('stale_owner'), false);
const staleOwner = (cause: unknown) => {
  const failure = new CodexToolFailure('stale_owner');
  failure.cause = cause;
  return failure;
};

/** Private read adapter only. Runtime registration supplies existing owners;
 * neither request JSON nor successful discovery can change workspace custody. */
export function sessionLocalRepositoryTools(
  owner: SessionLocalRepositoryToolOwner | NativeSessionLocalRepositoryToolOwner,
) {
  const nativeOwner = 'captureReader' in owner ? owner : undefined;
  const legacyOwner = 'captureReader' in owner ? undefined : owner;
  const factory = nativeOwner?.captureReader;
  const capture = owner.capture;
  const readPolicy = owner.readPolicy;
  const supplied = () =>
    owner &&
    typeof owner.capture === 'function' &&
    typeof owner.readPolicy === 'function' &&
    (nativeOwner
      ? typeof factory === 'function'
      : typeof legacyOwner?.assertPathAccess === 'function' &&
        typeof legacyOwner.captureReadAnchor === 'function' &&
        typeof legacyOwner.captureReadExclusions === 'function' &&
        typeof legacyOwner.executeReadOperation === 'function');
  return {
    definitions: supplied() ? localRepositoryToolDefinitions : [],
    async execute(
      name: string,
      input: Record<string, unknown>,
      callSignal: AbortSignal,
    ): Promise<{ content: string; isError: boolean } | undefined> {
      if (!Object.hasOwn(localRepositoryToolSchemas, name)) return undefined;
      if (callSignal.aborted) return codexToolFailureResult(callSignal.reason, true);
      if (!supplied()) return unavailable();
      let context: NativeHostToolContext | undefined;
      let reader: Awaited<ReturnType<typeof captureNativeLocalRepositoryReader>> | undefined;
      let assertOriginal: NativeHostToolContext['assertCurrentSync'] | undefined;
      let awaitOriginal: NativeHostToolContext['assertCurrent'] | undefined;
      let disposeOriginal: NativeHostToolContext['dispose'] | undefined;
      let originalSignal: AbortSignal | undefined;
      let readOwner: NativeHostReadOwner | undefined;
      let policy: LocalRepositoryReadPolicy | undefined;
      let assertPolicy: LocalRepositoryReadPolicy['assertCurrentSync'] | undefined;
      let signal: AbortSignal | undefined;
      const referencesCurrent = () => {
        if (
          !context ||
          owner.capture !== capture ||
          owner.readPolicy !== readPolicy ||
          (nativeOwner && nativeOwner.captureReader !== factory) ||
          context.signal !== originalSignal ||
          context.assertCurrentSync !== assertOriginal ||
          context.assertCurrent !== awaitOriginal ||
          context.dispose !== disposeOriginal ||
          (policy && policy.assertCurrentSync !== assertPolicy) ||
          context.toolName !== name ||
          context.requestHash !==
            createHash('sha256').update(JSON.stringify(input)).digest('hex') ||
          typeof context.assertCurrentSync !== 'function' ||
          typeof context.assertCurrent !== 'function' ||
          typeof context.dispose !== 'function'
        )
          throw Error('Original native call required');
      };
      const projectionCurrent = () => {
        signal?.throwIfAborted();
        callSignal.throwIfAborted();
        referencesCurrent();
        if (policy) {
          if (typeof assertPolicy !== 'function') throw Error('Current read policy required');
          assertSynchronous(() => assertPolicy!.call(policy!));
        }
        referencesCurrent();
        signal?.throwIfAborted();
        callSignal.throwIfAborted();
      };
      const current = () => {
        projectionCurrent();
        assertSynchronous(() =>
          readOwner ? readOwner.assertCurrentSync() : assertOriginal!.call(context!),
        );
        projectionCurrent();
      };
      const currentAsync = async () => {
        if (!readOwner) current();
        else projectionCurrent();
        const checked: unknown = await (readOwner
          ? readOwner.assertCurrent()
          : awaitOriginal!.call(context!));
        if (checked !== undefined) throw Error('Original native current owner required');
        if (!readOwner) current();
        else projectionCurrent();
      };
      const run = async () => {
        try {
          context = capture.call(owner, name, input, callSignal);
          assertOriginal = context.assertCurrentSync;
          awaitOriginal = context.assertCurrent;
          disposeOriginal = context.dispose;
          originalSignal = context.signal;
          signal = AbortSignal.any([callSignal, context.signal]);
          if (nativeOwner) {
            readOwner = captureNativeHostReadOwner(context);
            if (
              !readOwner ||
              readOwner.context !== context ||
              readOwner.scope !== context.nativeBaseReadScope ||
              readOwner.signal !== originalSignal
            )
              throw Error('Original compound native read owner required');
          }
          current();
          const parsed =
            localRepositoryToolSchemas[name as keyof typeof localRepositoryToolSchemas].safeParse(
              input,
            );
          if (!parsed.success)
            return { content: 'Invalid local repository tool input', isError: true };
          await currentAsync();
          policy = await readPolicy.call(owner, context, signal);
          if (!policy) throw Error('Current read policy required');
          assertPolicy = policy.assertCurrentSync;
          current();
          const snapshot = structuredClone({
            accessScope: policy.accessScope,
            discoveryRoots: policy.discoveryRoots,
            repositoryCatalog: policy.repositoryCatalog,
            orientationHints: policy.orientationHints,
            limits: policy.limits,
          });
          if (!snapshot.accessScope || !Array.isArray(snapshot.discoveryRoots))
            throw Error('Qualified read policy required');
          const deadline =
            Date.now() +
            Math.max(1, Math.min(60000, Math.floor(snapshot.limits?.timeoutMs ?? 15000)));
          if (nativeOwner) {
            reader = await factory!.call(nativeOwner, context, { deadline });
            current();
            if (
              !reader ||
              !Object.isFrozen(reader) ||
              reader.deadline !== deadline ||
              typeof reader.revalidate !== 'function' ||
              typeof reader.assertCurrentSync !== 'function' ||
              typeof reader.executeReadOperation !== 'function' ||
              typeof reader.executeDirectoryVerification !== 'function' ||
              typeof reader.dispose !== 'function'
            )
              throw Error('Original complete native reader required');
          }
          const request = {
            ...snapshot,
            signal,
            captureReadExclusions: async () => {
              current();
              if (!reader) await currentAsync();
              current();
              const exclusions = reader
                ? reader.deniedRoots
                : await legacyOwner!.captureReadExclusions(context!, signal!);
              current();
              return freezeNativeReadExclusions(exclusions);
            },
            captureReadAnchor: async (path: string) => {
              current();
              if (!reader) {
                await legacyOwner!.assertPathAccess(context!, path, signal!);
                current();
              }
              const anchor = await (reader
                ? reader.captureReadAnchor(path)
                : legacyOwner!.captureReadAnchor(context!, path, signal!));
              current();
              return anchor;
            },
            executeReadOperation: async (
              operation: NativeAnchoredReadRequest,
              operationSignal: AbortSignal,
              timeoutMs: number,
            ) => {
              current();
              await currentAsync();
              current();
              const result = await legacyOwner!.executeReadOperation(
                context!,
                operation,
                AbortSignal.any([signal!, operationSignal]),
                timeoutMs,
              );
              await currentAsync();
              current();
              return result;
            },
            assertReadAccess: async (path: string) => {
              // The exact reader reasserts its genuine owner synchronously after
              // this awaited ceiling. Only its producer-owned compound facet
              // permits avoiding a duplicate invocation here.
              if (reader && readOwner) projectionCurrent();
              else current();
              if (!reader) {
                await legacyOwner!.assertPathAccess(context!, path, signal!);
                current();
              }
            },
          };
          const forward = <T extends object>(value: T) => {
            if (reader) Object.defineProperty(value, 'nativeReader', { value: reader });
            return value;
          };
          const revalidateReadAccess = async () => {
            await currentAsync();
          };
          const result =
            name === 'DiscoverLocalRepository'
              ? await discoverLocalRepository(
                  forward({
                    ...request,
                    revalidateReadAccess,
                    query: 'query' in parsed.data ? parsed.data.query : undefined,
                    explicitPath: parsed.data.path,
                  }),
                )
              : await inspectLocalRepository(
                  forward({ ...request, revalidateReadAccess, path: parsed.data.path! }),
                );
          await currentAsync();
          return { content: JSON.stringify(result), isError: false };
        } catch (error) {
          try {
            current();
          } catch (cause) {
            // Withhold facts after authority loss while retaining the original
            // read failure separately from the failed currentness check.
            return await withCodexToolCleanup(async () => {
              throw error;
            }, [
              () => {
                throw staleOwner(cause);
              },
            ]);
          }
          if (error instanceof LocalRepositoryGitInspectionError)
            return {
              content: JSON.stringify({
                state: error.kind === 'access' ? 'access-required' : 'inspection-unavailable',
                reason: error.reason,
                needed:
                  error.kind === 'access'
                    ? ['read-access']
                    : error.kind === 'limit'
                      ? ['narrower-search']
                      : [],
              }),
              isError: true,
            };
          throw error;
        }
      }; // Capture failures and read refusals return only the bounded error projection.
      let cleanupFailed = false;
      let cleanupSettled = false;
      try {
        return await withCodexToolCleanup(run, [
          async () => {
            if (!reader) return;
            try {
              const closed: unknown = await reader.dispose();
              if (closed !== undefined) throw Error('Native reader cleanup did not settle');
              cleanupSettled = nativeRepositoryReadCleanupSettled(reader);
            } catch (error) {
              cleanupFailed = true;
              throw error;
            }
          },
          async () => {
            // Recheck after cleanup even when another cleanup failed. Never
            // deliver partially read facts under a replaced native owner.
            if (!nativeOwner || !context) return;
            try {
              await currentAsync();
            } catch (cause) {
              cleanupFailed = true;
              throw staleOwner(cause);
            }
          },
          () => {
            if (!context || !disposeOriginal) return;
            try {
              assertSynchronous(() => disposeOriginal!.call(context!));
            } catch (error) {
              cleanupFailed = true;
              cleanupSettled = false;
              throw error;
            }
          },
        ]);
      } catch (error) {
        const refusal = codexToolFailureResult(error, callSignal.aborted || !!signal?.aborted);
        const projected = JSON.parse(refusal.content);
        createLogger('local-repository-tools').warn('Local repository read failed', {
          toolName: name,
          conversationId: context?.conversationId,
          callId: context?.callId,
          turnId: context?.turnId,
          diagnosticId: projected.diagnosticId,
          toolFailureCode: projected.error,
          diagnostic: projected.diagnostic,
        });
        // Only physical joined cleanup can prove settlement after a failed fence.
        return cleanupFailed && cleanupSettled
          ? retainCallbackOutcome(refusal, 'settled')
          : refusal;
      }
    },
  };
}
