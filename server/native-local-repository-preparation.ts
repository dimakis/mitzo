import { isDeepStrictEqual } from 'node:util';
import { isAbsolute, resolve } from 'node:path';
import type { NativeHostToolContext } from './native-host-tool-context.js';
import { normalizeCodexToolResult } from './codex-tool-result.js';
import { PendingHostTaskReceiptSchema, pendingHostTaskDecisionHash } from './pending-host-task.js';
import { inputSchema } from './local-repository-preparation-authorization.js';
import { localRepositoryPreparationId, repositorySourceIdentity } from './local-repository-base.js';
import { captureNativeLocalRepositoryReader } from './local-repository-native-read.js';
import { LocalRepositoryReadAccess } from './local-repository-read-access.js';
import { assertPreparedRepositoryTaskTopology } from './prepared-repository-workspace-owner.js';
import { captureNativeLocalRepositoryPreparationSource } from './local-repository-preparation-source.js';
import type {
  LocalRepositoryRemoteGit,
  LocalRepositoryRemoteRequest,
} from './local-repository-base.js';
import {
  executeLocalRepositoryPreparation,
  withLocalRepositoryPreparationEnvelope,
  type LocalRepositoryPreparationOwners,
} from './local-repository-preparation-operation.js';

export type NativeLocalRepositoryRemoteAuthorization = (
  context: NativeHostToolContext,
  input: LocalRepositoryRemoteRequest,
) => Promise<LocalRepositoryRemoteGit>;
type Owners = Pick<LocalRepositoryPreparationOwners, 'events' | 'registry' | 'workspaces'> & {
  capture(signal: AbortSignal): NativeHostToolContext;
  authorizeRemote?: NativeLocalRepositoryRemoteAuthorization;
};
const unavailable = () => Error('Original native repository preparation unavailable');
function strict(result: unknown): void {
  if (result === undefined) return;
  void Promise.resolve(result).catch(() => {});
  throw unavailable();
}

/** Private callback composition only. Public tool declarations/admission remain
 * withheld. The existing operation owns approval, bytes, effects and cleanup;
 * this adapter never adopts a primary or treats a materialized row as a grant. */
export async function executeNativeLocalRepositoryPreparation(
  owners: Owners,
  rawInput: unknown,
  originalSignal: AbortSignal,
) {
  const capture = owners.capture;
  const authorizeRemote = owners.authorizeRemote;
  const events = owners.events,
    registry = owners.registry,
    workspaces = owners.workspaces;
  const publicReceipt = await withLocalRepositoryPreparationEnvelope(
    originalSignal,
    async (envelope) => {
      envelope.assertCurrentSync();
      if (typeof capture !== 'function' || owners.capture !== capture) throw unavailable();
      // Mint the total bound BEFORE the genuine original pending-call capture.
      const context = Reflect.apply(capture, owners, [envelope.signal]);
      const sources: Awaited<ReturnType<typeof captureNativeLocalRepositoryPreparationSource>>[] =
        [];
      const sync = context.assertCurrentSync,
        full = context.assertCurrent,
        dispose = context.dispose;
      const signal = context.signal,
        scope = context.nativeBaseReadScope,
        facet = context.captureNativeReadOwner;
      const current = () => {
        envelope.assertCurrentSync();
        signal.throwIfAborted();
        if (
          !Object.isFrozen(context) ||
          context.toolName !== 'PrepareLocalRepository' ||
          owners.capture !== capture ||
          owners.authorizeRemote !== authorizeRemote ||
          owners.events !== events ||
          owners.registry !== registry ||
          owners.workspaces !== workspaces ||
          context.signal !== signal ||
          context.assertCurrentSync !== sync ||
          context.assertCurrent !== full ||
          context.dispose !== dispose ||
          context.nativeBaseReadScope !== scope ||
          context.captureNativeReadOwner !== facet
        )
          throw unavailable();
        strict(Reflect.apply(sync, context, []));
      };
      try {
        current();
        const input = inputSchema.parse(rawInput);
        const binding = context.session.accountBinding;
        if (!binding) throw unavailable();
        const sourceIntent = input.source ?? { kind: 'existing' as const, path: input.path! };
        const sourceIdentity = repositorySourceIdentity(sourceIntent);
        if (pendingHostTaskDecisionHash(rawInput) !== context.requestHash) throw unavailable();
        await context.assertCurrent();
        current();
        const existing = workspaces.findLocalRepositoryPreparation({
          id: localRepositoryPreparationId({
            conversationId: context.conversationId,
            workspaceId: context.workspace.id,
            path: sourceIdentity,
            base: input.base,
            ...(input.newCheckout ? { generation: context.nativeTarget.commandId } : {}),
          }),
          conversationId: context.conversationId,
          workspace: context.workspace,
          path: sourceIdentity,
          base: input.base,
          binding,
          ...(input.newCheckout ? { newCheckout: true } : {}),
        });
        current();
        if (existing) {
          if (
            (!existing.retirement || existing.retirement.disposition === 'restored') &&
            existing.state === 'claimed' &&
            existing.id === context.workspace.id &&
            existing.taskIdentity &&
            existing.qualifiedLocalPreparation
          ) {
            const reader = await captureNativeLocalRepositoryReader(context, {
              deadline: Math.min(envelope.deadline, Date.now() + 30000),
            });
            try {
              await assertPreparedRepositoryTaskTopology(
                new LocalRepositoryReadAccess(reader),
                existing.taskIdentity,
                existing.qualifiedLocalPreparation.allocationFacts.source.gitDirectory,
              );
              await context.assertCurrent();
              current();
            } finally {
              await reader.dispose();
            }
            current();
            return {
              preparationId: existing.id,
              directory: existing.directory!,
              state: 'active' as const,
            };
          }
          await context.assertCurrent();
          current();
          return {
            preparationId: existing.id,
            directory: existing.pendingHostTask?.directory,
            state: 'pending' as const,
            preparationState: existing.retirement
              ? 'retiring'
              : (existing.pendingHostTask?.state ?? 'selected'),
            message:
              'This task already has a repository preparation. Continue its existing transition or reconcile this preparation before retrying.',
          };
        }
        const receipt = PendingHostTaskReceiptSchema.parse(
          await executeLocalRepositoryPreparation(
            {
              context,
              events,
              registry,
              workspaces,
              qualifySource: async (path, original, intent, options) => {
                current();
                if (
                  original !== context ||
                  path !== intent.sourcePath ||
                  (intent.source && intent.source.kind !== 'existing'
                    ? path !== repositorySourceIdentity(intent.source)
                    : !isAbsolute(path) || resolve(path) !== path) ||
                  !options ||
                  options.deadline !== envelope.deadline
                )
                  throw unavailable();
                // Preserve the actual returned owner AND its nonenumerable packed-ref witness.
                const source = await captureNativeLocalRepositoryPreparationSource(
                  original,
                  intent,
                  Object.freeze({ ...options, ...(authorizeRemote ? { authorizeRemote } : {}) }),
                );
                sources.push(source);
                current();
                return source;
              },
            },
            rawInput,
            envelope,
          ),
        );
        current();
        strict(await Reflect.apply(full, context, []));
        current();
        if (
          receipt.state !== 'materialized' ||
          receipt.request.conversationId !== context.conversationId ||
          receipt.request.runtimeId !== context.runtimeId ||
          receipt.request.prepareCallId !== context.callId ||
          receipt.request.requestHash !== context.requestHash ||
          !isDeepStrictEqual(receipt.request.nativeTarget, context.nativeTarget) ||
          !isDeepStrictEqual(receipt.request.binding, context.session.accountBinding) ||
          receipt.taskIdentity?.directory !== receipt.directory
        )
          throw unavailable();
        return {
          preparationId: receipt.request.id,
          directory: receipt.directory,
          state: 'materialized' as const,
        };
      } finally {
        // Joining cleanup is part of the callback: never outward-return success
        // while a disposer is pending, failed, or the total/original lifetime expired.
        try {
          for (const source of sources) await source.dispose?.();
        } finally {
          strict(await Reflect.apply(dispose, context, []));
        }
        envelope.assertCurrentSync();
      }
    },
  );
  return normalizeCodexToolResult({ content: JSON.stringify(publicReceipt), isError: false });
}
