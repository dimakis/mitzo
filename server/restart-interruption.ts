import type { UnsettledToolCall } from '@mitzo/protocol/event-store';
import type { EventStore } from './event-store.js';
import { createLogger } from './logger.js';

const log = createLogger('restart-interruption');

type RestartStore = Pick<
  EventStore,
  | 'recoverStaleSessions'
  | 'recoverOrphanedExecutionTokens'
  | 'recoverPendingSendCommands'
  | 'settleRestartedOrdinarySdkCommands'
  | 'settleUnacknowledgedOrdinarySdkCommand'
  | 'getExecutionCommandId'
  | 'getOrdinaryLocalVertexCommandAdmission'
  | 'getOrdinarySdkTurnEvents'
  | 'getUnsettledToolCalls'
  | 'append'
>;

const MAX_LISTED_CALLS = 5;

/** User-facing notice for a turn the restart cut. It names what may have run
 * and what to do next; nothing is replayed on the user's behalf. */
export function restartInterruptionMessage(calls: UnsettledToolCall[] | undefined): string {
  const head =
    'Mitzo restarted while this turn was running, so the turn stopped. Nothing was re-run.';
  const next = 'Send a message to continue.';
  if (!calls) return `${head} Mitzo could not tell which tool calls were in progress. ${next}`;
  if (!calls.length) return `${head} No tool call was in progress. ${next}`;
  const listed = calls
    .slice(0, MAX_LISTED_CALLS)
    .map((call) => (call.input ? `${call.toolName} (${call.input})` : call.toolName));
  const more =
    calls.length > MAX_LISTED_CALLS ? ` and ${calls.length - MAX_LISTED_CALLS} more` : '';
  return `${head} These tool calls may or may not have taken effect: ${listed.join('; ')}${more}. Check them before relying on or repeating them. ${next}`;
}

/** Startup recovery for work a previous server process left in flight.
 * Claude SDK chats end the cut turn in a named, recoverable state and settle
 * any command whose delivery the restart left unconfirmed, so the next
 * explicit message is admitted. Codex keeps its own native recovery. */
export function recoverAfterRestart(
  store: RestartStore,
  options: { excludeSymposium?: boolean } = {},
): void {
  store.recoverStaleSessions(options);
  const interrupted = store.recoverOrphanedExecutionTokens(options);
  const { settled, unsettled } = store.settleRestartedOrdinarySdkCommands(options);
  for (const { sessionId, commandId, cause } of unsettled)
    log.warn('Restarted SDK command could not be settled', {
      code: 'restart_command_settlement_failed',
      stage: 'startup_recovery',
      sessionId,
      commandId,
      err: cause,
    });
  for (const token of interrupted) {
    try {
      const commandId = store.getExecutionCommandId(token);
      if (!commandId || !store.getOrdinaryLocalVertexCommandAdmission(commandId)) continue;
      // Only a turn whose input the CLI acknowledged can have run tools.
      if (
        !store
          .getOrdinarySdkTurnEvents(token.sessionId, commandId)
          .some((event) => event.type === 'ordinary_sdk_turn_accepted')
      ) {
        // Input pushed (receipt consumed) but never echoed: delivery is
        // unknown. A still-uncertain claim was settled above with its notice.
        if (store.settleUnacknowledgedOrdinarySdkCommand(token.sessionId, commandId))
          settled.push({ sessionId: token.sessionId, commandId, outcome: 'unknown' });
        continue;
      }
      const calls = store.getUnsettledToolCalls(token);
      store.append(token.sessionId, 'error', {
        type: 'error',
        v: 2,
        sessionId: token.sessionId,
        error: restartInterruptionMessage(calls),
        interruption: {
          reason: 'server_restart',
          commandId,
          ...(calls ? { uncertainOperations: calls } : {}),
        },
      });
      log.info('Turn interrupted by server restart', {
        sessionId: token.sessionId,
        commandId,
        uncertainOperations: calls?.length ?? 'unknown',
      });
    } catch (cause) {
      log.warn('Restart interruption notice unavailable', {
        code: 'restart_interruption_notice_failed',
        stage: 'startup_recovery',
        sessionId: token.sessionId,
        err: cause,
      });
    }
  }
  if (settled.length)
    log.info('Restarted SDK commands settled', {
      commands: settled.map(({ sessionId, commandId, outcome }) => ({
        sessionId,
        commandId,
        outcome,
      })),
    });
  store.recoverPendingSendCommands(options);
}
