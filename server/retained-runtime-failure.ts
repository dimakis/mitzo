import type { ManagedSession, SessionTransport } from '@mitzo/harness';
import type { EventStore } from './event-store.js';
import { SessionRuntimeError, findSessionRuntimeError } from './session-runtime-error.js';
import { createLogger } from './logger.js';

const log = createLogger('retained-runtime-failure');
const unclassified = new WeakMap<Error, SessionRuntimeError>();
/** One durable, sanitized report for the original command. Reporting never
 * marks its send failed, retires its receipt, releases a queue, or calls a provider. */
export function reportRetainedRuntimeFailure(input: {
  store: EventStore;
  sessionId: string;
  commandId?: string;
  session?: Pick<ManagedSession, 'transport' | 'observers'>;
  transport?: SessionTransport;
  error: unknown;
  describe?: (error: Error) => string;
}): void {
  const retained = findSessionRuntimeError(input.error);
  let failure =
    retained ?? (input.error instanceof Error ? unclassified.get(input.error) : undefined);
  if (!failure) {
    failure = new SessionRuntimeError('runtime_unavailable', { cause: input.error });
    if (input.error instanceof Error) unclassified.set(input.error, failure);
  }
  const message = retained
    ? retained.publicMessage()
    : input.describe && input.error instanceof Error
      ? `${input.describe(input.error)} Reference: ${failure.diagnosticId}`
      : failure.publicMessage();
  let event: Record<string, unknown> = {
    v: 2,
    type: 'error',
    sessionId: input.sessionId,
    error: message,
    runtimeFailure: failure.telemetry(),
  };
  try {
    const previous = input.store.getLatestEvent(input.sessionId, 'error');
    if (
      (previous?.payload.runtimeFailure as Record<string, unknown> | undefined)?.diagnosticId ===
      failure.diagnosticId
    )
      return;
    if (input.commandId && input.store.hasUserMessage(input.sessionId, input.commandId)) {
      event = {
        ...event,
        clientMsgId: input.commandId,
        retainedCommandFailure: true,
        error: `Message saved. ${message}`,
      };
    }
    const seq = input.store.append(input.sessionId, 'error', event);
    event = {
      ...event,
      seq,
      prevSessionSeq: input.store.getSessionPredecessorSeq(input.sessionId, seq),
    };
  } catch {
    log.warn('Runtime failure could not be retained', {
      sessionId: input.sessionId,
      ...failure.telemetry(),
    });
  }
  log.warn('Saved runtime work requires attention', {
    sessionId: input.sessionId,
    ...failure.telemetry(),
  });
  for (const transport of new Set([
    input.session?.transport ?? input.transport,
    ...(input.session?.observers ?? []),
  ])) {
    try {
      if (transport?.isOpen()) transport.send(event);
    } catch {
      /* A disconnected viewer does not erase the retained diagnostic. */
    }
  }
}
