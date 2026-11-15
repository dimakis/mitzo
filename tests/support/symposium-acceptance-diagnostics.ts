import type { EventStore } from '../../server/event-store.js';

/** Failure observations grant no admission/recovery authority. Never serialize
 * receipts, session metadata or caught errors wholesale. */
export function observeAcceptance<T>(observation: string, read: () => T) {
  try {
    return { status: 'observed' as const, value: read() };
  } catch {
    return {
      status: 'unavailable' as const,
      code: 'acceptance_observation_unavailable' as const,
      observation,
    };
  }
}

type Owner = Pick<
  EventStore,
  | 'getSendCommand'
  | 'getOrdinaryCommandExecutionAdmission'
  | 'getCurrentExecutionCommandId'
  | 'getSession'
>;

export function observeAcceptanceCommand(owner: Owner, sessionId: string, commandId: string) {
  return {
    sessionId,
    commandId,
    send: observeAcceptance('send_command', () => {
      const receipt = owner.getSendCommand(commandId);
      return receipt
        ? {
            exists: true,
            clientMsgId: receipt.clientMsgId,
            sessionId: receipt.sessionId,
            hasError: receipt.error !== null,
          }
        : { exists: false };
    }),
    admission: observeAcceptance(
      'execution_admission',
      () => owner.getOrdinaryCommandExecutionAdmission(commandId)?.state ?? null,
    ),
    currentCommand: observeAcceptance(
      'current_command',
      () => owner.getCurrentExecutionCommandId(sessionId) ?? null,
    ),
    session: observeAcceptance('session_execution', () => {
      const session = owner.getSession(sessionId);
      return session
        ? {
            sessionId: session.sessionId,
            executionPhase: session.executionPhase,
            executionGeneration: session.executionGeneration,
          }
        : null;
    }),
  };
}
