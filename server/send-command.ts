import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { V2SendMessage } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import {
  executionRequestFromValidatedSend,
  fingerprintExecutionRequest,
} from './execution-request.js';

type SendMessage = z.infer<typeof V2SendMessage>;
export type SendReceipt = {
  ok: true;
  accepted: true;
  clientMsgId: string;
  sessionId: string | null;
  /** The durable command is accepted but awaits FIFO activation. */
  pending?: true;
};

/** A dispatcher can detach bounded FIFO activation from the HTTP receipt. */
export type QueuedSendDispatch = {
  queued: true;
  /** Resolves only when the queued execution was admitted; rejects on cancellation/failure. */
  completion: Promise<void>;
};

type ReceiptInput = {
  requestFingerprint: string;
  legacyCommand: Record<string, unknown>;
};

/** A dispatch failure whose message is safe to persist and replay to a client. */
export class SendDispatchFailure extends Error {
  constructor(message = 'Unable to start the chat. Please retry.') {
    super(message);
    this.name = 'SendDispatchFailure';
  }
}

const pendingAsyncAcceptances = new WeakMap<EventStore, Map<string, Promise<void>>>();

function pendingReceipt(receipt: { clientMsgId: string; sessionId: string | null }): SendReceipt {
  return { ok: true, accepted: true, pending: true, ...receipt };
}

function acceptedReceipt(receipt: { clientMsgId: string; sessionId: string | null }): SendReceipt {
  return { ok: true, accepted: true, ...receipt };
}

function isQueuedSendDispatch(value: unknown): value is QueuedSendDispatch {
  return !!value && typeof value === 'object' && (value as { queued?: unknown }).queued === true;
}

/** HTTP command acceptance is independent of event-stream connectivity.
 * A receipt is durable before dispatch; retries return that same receipt.
 * This guarantees one dispatch, not exactly-once external tool execution.
 */
export function acceptSendCommand(
  store: EventStore,
  message: SendMessage,
  receiptOrDispatch: ReceiptInput | ((message: SendMessage, sessionId: string) => void | false),
  maybeDispatch?: (message: SendMessage, sessionId: string) => void | false,
): { ok: true; accepted: true; clientMsgId: string; sessionId: string | null } {
  const receiptInput =
    typeof receiptOrDispatch === 'function'
      ? {
          // Compatibility-only fallback for receipt unit callers. Shared REST/WS
          // paths must provide the prepared fingerprint explicitly.
          requestFingerprint: fingerprintExecutionRequest(
            executionRequestFromValidatedSend(message),
          ),
          legacyCommand: message,
        }
      : receiptOrDispatch;
  const dispatch = typeof receiptOrDispatch === 'function' ? receiptOrDispatch : maybeDispatch;
  if (!dispatch) throw new TypeError('A send dispatch callback is required');
  // Narrow test doubles from older handler tests intentionally omit durable
  // receipt APIs. Real EventStore instances always implement this boundary.
  if (typeof (store as Partial<EventStore>).claimSendCommandReceipt !== 'function') {
    const assignedSessionId = message.sessionId ?? randomUUID();
    const sessionId = dispatch(message, assignedSessionId) === false ? null : assignedSessionId;
    return { ok: true, accepted: true, clientMsgId: message.clientMsgId, sessionId };
  }
  const receipt = store.claimSendCommandReceipt(
    message.clientMsgId,
    message.sessionId ?? randomUUID(),
    receiptInput.requestFingerprint,
    receiptInput.legacyCommand,
  );
  if (receipt.receipt.error) throw new Error(receipt.receipt.error);
  let sessionId = receipt.receipt.sessionId;
  if (!receipt.duplicate) {
    try {
      if (dispatch(message, sessionId!) === false) {
        store.completeNativeSendCommand(message.clientMsgId);
        sessionId = null;
      }
      // Long-lived startup/query work can fail after admission resolves. Its
      // owner records and delivers that failure directly; do not turn it into
      // a second acknowledgement error here.
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
  receiptOrDispatch:
    | ReceiptInput
    | ((message: SendMessage, sessionId: string) => Promise<void | false | QueuedSendDispatch>),
  maybeDispatch?: (
    message: SendMessage,
    sessionId: string,
  ) => Promise<void | false | QueuedSendDispatch>,
): Promise<SendReceipt> {
  const receiptInput =
    typeof receiptOrDispatch === 'function'
      ? {
          // Compatibility-only fallback; application paths use prepared values.
          requestFingerprint: fingerprintExecutionRequest(
            executionRequestFromValidatedSend(message),
          ),
          legacyCommand: message,
        }
      : receiptOrDispatch;
  const dispatch = typeof receiptOrDispatch === 'function' ? receiptOrDispatch : maybeDispatch;
  if (!dispatch) throw new TypeError('A send dispatch callback is required');
  if (typeof (store as Partial<EventStore>).claimSendCommandReceipt !== 'function') {
    const sessionId = message.sessionId ?? randomUUID();
    return Promise.resolve(dispatch(message, sessionId)).then((outcome) =>
      acceptedReceipt({
        clientMsgId: message.clientMsgId,
        sessionId: outcome === false ? null : sessionId,
      }),
    );
  }
  const receipt = store.claimSendCommandReceipt(
    message.clientMsgId,
    message.sessionId ?? randomUUID(),
    receiptInput.requestFingerprint,
    receiptInput.legacyCommand,
  );
  let pending = pendingAsyncAcceptances.get(store);
  if (!pending) {
    pending = new Map();
    pendingAsyncAcceptances.set(store, pending);
  }
  const inFlight = pending.get(message.clientMsgId);
  if (receipt.receipt.error) throw new Error(receipt.receipt.error);
  // Never make a retry retain an HTTP worker while the original waits in a
  // bounded FIFO. The command ID is already durable, so the typed pending
  // receipt is enough for ordered outbox progress and exact idempotency.
  if (inFlight)
    return Promise.resolve(
      pendingReceipt({
        clientMsgId: message.clientMsgId,
        sessionId: receipt.receipt.sessionId,
      }),
    );
  if (receipt.duplicate) {
    return Promise.resolve(
      acceptedReceipt({ clientMsgId: message.clientMsgId, sessionId: receipt.receipt.sessionId }),
    );
  }

  const dispatchOutcome = Promise.resolve().then(() =>
    dispatch(message, receipt.receipt.sessionId!),
  );
  const tracking = (async (): Promise<void> => {
    try {
      const outcome = await dispatchOutcome;
      if (isQueuedSendDispatch(outcome)) {
        await outcome.completion;
        return;
      }
      if (outcome === false) {
        store.completeNativeSendCommand(message.clientMsgId);
      }
    } catch (err) {
      store.failSendCommand(
        message.clientMsgId,
        err instanceof Error ? err.message : 'Send failed',
      );
      throw err;
    }
  })();
  const clearPending = () => {
    if (pending.get(message.clientMsgId) === tracking) pending.delete(message.clientMsgId);
  };
  pending.set(message.clientMsgId, tracking);
  void tracking.then(clearPending, clearPending);
  return dispatchOutcome.then(
    (outcome) => {
      if (isQueuedSendDispatch(outcome))
        return pendingReceipt({
          clientMsgId: message.clientMsgId,
          sessionId: receipt.receipt.sessionId,
        });
      return tracking.then(() =>
        acceptedReceipt({
          clientMsgId: message.clientMsgId,
          sessionId: sessionIdForOutcome(outcome, receipt.receipt.sessionId),
        }),
      );
    },
    (error) => tracking.then(() => Promise.reject(error)),
  );
}

function sessionIdForOutcome(
  outcome: void | false | QueuedSendDispatch,
  sessionId: string | null,
): string | null {
  return outcome === false ? null : sessionId;
}
