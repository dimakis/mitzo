import { freezeNativeReadExclusions } from './native-file-operation.js';
import { createHash } from 'node:crypto';
import type { ToolDefinition } from '@mitzo/harness';
import { z } from 'zod';
import type { NativeHostToolContext } from './native-host-tool-context.js';
import {
  discoverLocalRepository,
  inspectLocalRepository,
  type LocalRepositoryLimits,
  type LocalRepositoryReadScope,
} from './local-repository-discovery.js';
import type { LocalRepositoryReadAnchor } from './local-repository-read-access.js';
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
  /** Existing actual path authority, rechecked as an additional ceiling. */
  assertPathAccess(
    context: NativeHostToolContext,
    path: string,
    signal: AbortSignal,
  ): Promise<void>;
}

function assertSynchronous(assertion: () => unknown) {
  const result = assertion();
  if (result === undefined) return;
  void Promise.resolve(result).catch(() => {});
  throw Error('Current local repository owner required');
}
const unavailable = () => ({
  content: 'Local repository reads are unavailable under the current native call and read policy.',
  isError: true,
});

/** Private read adapter only. Runtime registration supplies existing owners;
 * neither request JSON nor successful discovery can change workspace custody. */
export function sessionLocalRepositoryTools(owner: SessionLocalRepositoryToolOwner) {
  const supplied = () =>
    owner &&
    typeof owner.capture === 'function' &&
    typeof owner.readPolicy === 'function' &&
    typeof owner.assertPathAccess === 'function' &&
    typeof owner.captureReadAnchor === 'function' &&
    typeof owner.captureReadExclusions === 'function';
  return {
    definitions: supplied() ? localRepositoryToolDefinitions : [],
    async execute(
      name: string,
      input: Record<string, unknown>,
      callSignal: AbortSignal,
    ): Promise<{ content: string; isError: boolean } | undefined> {
      if (!Object.hasOwn(localRepositoryToolSchemas, name)) return undefined;
      if (!supplied() || callSignal.aborted) return unavailable();
      let context: NativeHostToolContext | undefined;
      let policy: LocalRepositoryReadPolicy | undefined;
      let signal: AbortSignal | undefined;
      const current = () => {
        signal?.throwIfAborted();
        callSignal.throwIfAborted();
        if (
          !context ||
          context.toolName !== name ||
          context.requestHash !==
            createHash('sha256').update(JSON.stringify(input)).digest('hex') ||
          typeof context.assertCurrentSync !== 'function' ||
          typeof context.assertCurrent !== 'function' ||
          typeof context.dispose !== 'function'
        )
          throw Error('Original native call required');
        assertSynchronous(() => context!.assertCurrentSync());
        if (policy) {
          if (typeof policy.assertCurrentSync !== 'function')
            throw Error('Current read policy required');
          assertSynchronous(() => policy!.assertCurrentSync());
        }
      };
      try {
        context = owner.capture(name, input, callSignal);
        signal = AbortSignal.any([callSignal, context.signal]);
        current();
        const parsed =
          localRepositoryToolSchemas[name as keyof typeof localRepositoryToolSchemas].safeParse(
            input,
          );
        if (!parsed.success)
          return { content: 'Invalid local repository tool input', isError: true };
        await context.assertCurrent();
        current();
        policy = await owner.readPolicy(context, signal);
        if (!policy) throw Error('Current read policy required');
        current();
        const snapshot = structuredClone({
          accessScope: policy.accessScope,
          discoveryRoots: policy.discoveryRoots,
          orientationHints: policy.orientationHints,
          limits: policy.limits,
        });
        if (!snapshot.accessScope || !Array.isArray(snapshot.discoveryRoots))
          throw Error('Qualified read policy required');
        const request = {
          ...snapshot,
          signal,
          captureReadExclusions: async () => {
            current();
            await context!.assertCurrent();
            current();
            const exclusions = await owner.captureReadExclusions(context!, signal!);
            current();
            return freezeNativeReadExclusions(exclusions);
          },
          captureReadAnchor: async (path: string) => {
            current();
            await owner.assertPathAccess(context!, path, signal!);
            current();
            const anchor = await owner.captureReadAnchor(context!, path, signal!);
            current();
            return anchor;
          },
          assertReadAccess: async (path: string) => {
            current();
            await owner.assertPathAccess(context!, path, signal!);
            current();
          },
        };
        const result =
          name === 'DiscoverLocalRepository'
            ? await discoverLocalRepository({
                ...request,
                query: 'query' in parsed.data ? parsed.data.query : undefined,
                explicitPath: parsed.data.path,
              })
            : await inspectLocalRepository({ ...request, path: parsed.data.path! });
        await context.assertCurrent();
        current();
        return { content: JSON.stringify(result), isError: false };
      } catch (error) {
        try {
          current();
          if (!policy) return unavailable();
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
        } catch {
          /* Expired authority cannot expose a partially read result. */
        }
        return unavailable();
      } finally {
        context?.dispose();
      }
    },
  };
}
