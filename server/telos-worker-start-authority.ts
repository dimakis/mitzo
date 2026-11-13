import { isDeepStrictEqual } from 'node:util';
import { TelosWorkDelegationReceiptSchema, type TelosWorkDelegationReceipt } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { OrdinaryFirstCommandAuthority } from './ordinary-first-command-authority.js';
import { assertOrdinarySynchronousFence } from './ordinary-turn-lifecycle.js';
import { TelosWorkStore } from './telos-work-store.js';
import { isAvailableTelosWorkConversation } from './telos-work-conversation.js';
import { resolveTelosWorkRoleContext } from './telos-work-role-context.js';
import { createLogger } from './logger.js';
import { sessionMetadataDiagnostic } from './session-metadata-error.js';
import { retainTelosDiagnosticFailure } from './telos-operation-failure.js';

/** The admitted command outlives the HTTP/tool response and its temporary work
 * connection. Keep source runtime custody, but reopen canonical assignment facts
 * at each pending first-command effect boundary. No invocation is borrowed. */
export function captureTelosWorkerFirstCommandAuthority(deps: {
  commandId: string;
  allocation: TelosWorkDelegationReceipt;
  events: EventStore;
  databasePath(): string;
  assertSourceCurrent(): void;
}): OrdinaryFirstCommandAuthority {
  const allocation = TelosWorkDelegationReceiptSchema.parse(structuredClone(deps.allocation));
  const { attempt, workerConversationId } = allocation;
  return Object.freeze({
    commandId: deps.commandId,
    assertCurrent() {
      assertOrdinarySynchronousFence(deps.commandId, deps.assertSourceCurrent);
      const source = deps.events.getSession(attempt.leadConversationId);
      const role = resolveTelosWorkRoleContext(
        deps.events,
        attempt.leadConversationId,
        source?.accountBinding ?? undefined,
      );
      if (role?.role !== 'lead') throw Error('Original retained lead role required');
      const work = TelosWorkStore.openReadOnly(deps.databasePath(), {
        ordinaryConversation: (id) => isAvailableTelosWorkConversation(deps.events.getSession(id)),
      });
      let failure: { cause: unknown } | undefined;
      try {
        work.readDelegationTarget(attempt.leadConversationId, attempt.childItemId, role.itemId);
        const current = work.executionTaskBinding(
          attempt.executionTaskId!,
          workerConversationId,
          true,
        );
        if (!current || !isDeepStrictEqual(current, attempt))
          throw Error('Original worker startup authority changed');
      } catch (cause) {
        failure = { cause };
      }
      try {
        work.close();
      } catch (cause) {
        try {
          createLogger('telos-worker-start').warn(
            'Worker startup authority connection cleanup failed',
            {
              stage: 'first_command_authority_cleanup',
              code: 'telos_start_authority_cleanup_failed',
              commandId: deps.commandId,
              workerConversationId,
              ...sessionMetadataDiagnostic(cause),
            },
          );
        } catch (diagnosticCause) {
          retainTelosDiagnosticFailure(cause, diagnosticCause, {
            stage: 'first_command_authority_cleanup',
            operation: 'start_worker',
            sessionId: workerConversationId,
          });
        }
        failure ??= { cause };
      }
      if (failure) throw failure.cause;
    },
  });
}
