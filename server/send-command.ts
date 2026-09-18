import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { V2SendMessage } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import {
  executionRequestFromValidatedSend,
  fingerprintExecutionRequest,
} from './execution-request.js';

type SendMessage = z.infer<typeof V2SendMessage>;
type SendReceipt = {
  ok: true;
  accepted: true;
  clientMsgId: string;
  sessionId: string | null;
};

const pendingAsyncAcceptances = new WeakMap<EventStore, Map<string, Promise<SendReceipt>>>();

/** HTTP command acceptance is independent of event-stream connectivity.
 * A receipt is durable before dispatch; retries return that same receipt.
 * This guarantees one dispatch, not exactly-once external tool execution.
 */
export function acceptSendCommand(
  store: EventStore,
  message: SendMessage,
  dispatch: (message: SendMessage, sessionId: string) => void | false,
): { ok: true; accepted: true; clientMsgId: string; sessionId: string | null } {
  const requestFingerprint = fingerprintExecutionRequest(
    executionRequestFromValidatedSend(message),
  );
  const receipt = store.claimSendCommandReceipt(
    message.clientMsgId,
    message.sessionId ?? randomUUID(),
    requestFingerprint,
    message,
  );
  if (receipt.receipt.error) throw new Error(receipt.receipt.error);
  let sessionId = receipt.receipt.sessionId;
  if (!receipt.duplicate) {
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
  dispatch: (message: SendMessage, sessionId: string) => Promise<void | false>,
): Promise<SendReceipt> {
  const requestFingerprint = fingerprintExecutionRequest(
    executionRequestFromValidatedSend(message),
  );
  const receipt = store.claimSendCommandReceipt(
    message.clientMsgId,
    message.sessionId ?? randomUUID(),
    requestFingerprint,
    message,
  );
  let pending = pendingAsyncAcceptances.get(store);
  if (!pending) {
    pending = new Map();
    pendingAsyncAcceptances.set(store, pending);
  }
  const inFlight = pending.get(message.clientMsgId);
  if (inFlight) return inFlight;
  if (receipt.receipt.error) throw new Error(receipt.receipt.error);
  if (receipt.duplicate) {
    return Promise.resolve({
      ok: true,
      accepted: true,
      clientMsgId: message.clientMsgId,
      sessionId: receipt.receipt.sessionId,
    });
  }

  const admission = (async (): Promise<SendReceipt> => {
    let sessionId = receipt.receipt.sessionId;
    try {
      if ((await dispatch(message, sessionId!)) === false) {
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
    return { ok: true, accepted: true, clientMsgId: message.clientMsgId, sessionId };
  })();
  const clearPending = () => {
    if (pending.get(message.clientMsgId) === admission) pending.delete(message.clientMsgId);
  };
  pending.set(message.clientMsgId, admission);
  void admission.then(clearPending, clearPending);
  return admission;
}
