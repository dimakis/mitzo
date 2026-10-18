import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { z } from 'zod';
import type { V2SendMessage } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';

type SendMessage = z.infer<typeof V2SendMessage>;
type SendReceipt = {
  ok: true;
  accepted: true;
  clientMsgId: string;
  sessionId: string | null;
  retained?: true;
};

export interface AcceptSendCommandAsyncOptions {
  /** Re-dispatch an exact existing receipt so a command-specific gate can
   * revalidate current routing/configuration without changing its identity. */
  replayExisting?: boolean;
  /** Return a receipt after the exact prompt is durable; execution remains gated. */
  acknowledgeRetained?: boolean;
}

const pendingAsyncAcceptances = new WeakMap<EventStore, Map<string, Promise<SendReceipt>>>();

function assertLegacySend(store: EventStore, message: SendMessage): void {
  const retainedSessionId = store.getSendCommand(message.clientMsgId)?.sessionId;
  if (
    store.getOrdinaryLocalCommandAdmission?.(message.clientMsgId) ||
    (retainedSessionId && store.getSessionRuntimeBinding?.(retainedSessionId)) ||
    (message.sessionId && store.getSessionRuntimeBinding?.(message.sessionId))
  )
    throw new Error('Runtime-bound commands require guarded admission');
}

/** HTTP command acceptance is independent of event-stream connectivity.
 * A receipt is durable before dispatch; retries return that same receipt.
 * This guarantees one dispatch, not exactly-once external tool execution.
 */
export function acceptSendCommand(
  store: EventStore,
  message: SendMessage,
  dispatch: (message: SendMessage, sessionId: string) => void | false,
): { ok: true; accepted: true; clientMsgId: string; sessionId: string | null } {
  assertLegacySend(store, message);
  const existing = store.getSendCommand(message.clientMsgId);
  if (existing && !isDeepStrictEqual(existing.payload, message))
    throw new Error('Command ID already used for a different message');
  if (existing?.error) throw new Error(existing.error);
  let sessionId = existing ? existing.sessionId : (message.sessionId ?? randomUUID());
  if (!existing) {
    store.insertSendCommand(message.clientMsgId, sessionId!, message);
    try {
      if (dispatch(message, sessionId!) === false) {
        store.completeNativeSendCommand(message.clientMsgId);
        sessionId = null;
      }
      const failed = store.getSendCommand(message.clientMsgId)?.error;
      if (failed) throw new Error(failed);
    } catch (err) {
      store.failSendCommand(
        message.clientMsgId,
        err instanceof Error ? err.message : 'Send failed',
      );
      throw err;
    }
  }
  return { ok: true, accepted: true, clientMsgId: message.clientMsgId, sessionId };
}

/** Async counterpart used when dispatch has an admission boundary that must
 * complete before the HTTP receipt is acknowledged. */
export function acceptSendCommandAsync(
  store: EventStore,
  message: SendMessage,
  dispatch: (
    message: SendMessage,
    sessionId: string,
    retained: () => void,
  ) => Promise<void | false>,
  options: AcceptSendCommandAsyncOptions = {},
): Promise<SendReceipt> {
  assertLegacySend(store, message);
  const existing = store.getSendCommand(message.clientMsgId);
  if (existing && !isDeepStrictEqual(existing.payload, message))
    throw new Error('Command ID already used for a different message');
  let pending = pendingAsyncAcceptances.get(store);
  if (!pending) {
    pending = new Map();
    pendingAsyncAcceptances.set(store, pending);
  }
  const inFlight = pending.get(message.clientMsgId);
  if (inFlight) return inFlight;
  if (existing?.error) throw new Error(existing.error);

  let acknowledgeRetention!: (receipt: SendReceipt) => void;
  const retained = new Promise<SendReceipt>((resolve) => {
    acknowledgeRetention = resolve;
  });
  const admission = (async (): Promise<SendReceipt> => {
    let sessionId = existing ? existing.sessionId : (message.sessionId ?? randomUUID());
    const shouldDispatch = !existing || !!options.replayExisting;
    if (shouldDispatch) {
      if (!existing) store.insertSendCommand(message.clientMsgId, sessionId!, message);
      try {
        if (!existing && options.acknowledgeRetained)
          store.setSendCommandPreparing(message.clientMsgId, true);
        const onRetained = () => {
          if (!options.acknowledgeRetained || existing) return;
          if (!store.hasUserMessage(sessionId!, message.clientMsgId))
            throw Error('Send acknowledgement requires the exact durable prompt');
          acknowledgeRetention({
            ok: true,
            accepted: true,
            clientMsgId: message.clientMsgId,
            sessionId,
            retained: true,
          });
        };
        if ((await dispatch(message, sessionId!, onRetained)) === false) {
          if (!existing) {
            store.completeNativeSendCommand(message.clientMsgId);
            sessionId = null;
          }
        }
        if (!existing) {
          const failed = store.getSendCommand(message.clientMsgId)?.error;
          if (failed) throw new Error(failed);
          if (options.acknowledgeRetained)
            store.setSendCommandPreparing(message.clientMsgId, false);
        }
      } catch (err) {
        // An exact replay is deliberately allowed to fail its command-specific
        // gate (for example, a changed provider route) without poisoning the
        // original global receipt or changing its retry identity.
        if (!existing)
          store.failSendCommand(
            message.clientMsgId,
            err instanceof Error ? err.message : 'Send failed',
          );
        throw err;
      }
    }
    return {
      ok: true,
      accepted: true,
      clientMsgId: message.clientMsgId,
      sessionId,
      ...(options.acknowledgeRetained &&
      sessionId &&
      store.hasUserMessage(sessionId, message.clientMsgId)
        ? { retained: true as const }
        : {}),
    };
  })();
  const acknowledgment = options.acknowledgeRetained
    ? Promise.race([admission, retained])
    : admission;
  const clearPending = () => {
    if (pending.get(message.clientMsgId) === acknowledgment) pending.delete(message.clientMsgId);
  };
  pending.set(message.clientMsgId, acknowledgment);
  void admission.then(clearPending, clearPending);
  return acknowledgment;
}
