import { isDeepStrictEqual } from 'node:util';
import { isAbsolute, resolve } from 'node:path';
import type { NativeHostToolContext } from './native-host-tool-context.js';
import { normalizeCodexToolResult } from './codex-tool-result.js';
import { PendingHostTaskReceiptSchema } from './pending-host-task.js';
import { captureNativeLocalRepositoryPreparationSource } from './local-repository-preparation-source.js';
import {
  executeLocalRepositoryPreparation,
  withLocalRepositoryPreparationEnvelope,
  type LocalRepositoryPreparationOwners,
} from './local-repository-preparation-operation.js';

type Owners = Pick<LocalRepositoryPreparationOwners, 'events' | 'registry' | 'workspaces'> & {
  capture(signal: AbortSignal): NativeHostToolContext;
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
                  !isAbsolute(path) ||
                  resolve(path) !== path ||
                  !options ||
                  options.deadline !== envelope.deadline
                )
                  throw unavailable();
                // Preserve the actual returned owner AND its nonenumerable packed-ref witness.
                const source = await captureNativeLocalRepositoryPreparationSource(
                  original,
                  intent,
                  options,
                );
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
        strict(await Reflect.apply(dispose, context, []));
        envelope.assertCurrentSync();
      }
    },
  );
  return normalizeCodexToolResult({ content: JSON.stringify(publicReceipt), isError: false });
}
