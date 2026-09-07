import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { z } from 'zod';
import type { V2SendMessage } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';

type SendMessage = z.infer<typeof V2SendMessage>;

/** HTTP command acceptance is independent of event-stream connectivity.
 * A receipt is durable before dispatch; retries return that same receipt.
 * This guarantees one dispatch, not exactly-once external tool execution.
 */
export function acceptSendCommand(
  store: EventStore,
  message: SendMessage,
  dispatch: (message: SendMessage, sessionId: string) => void | false,
): { ok: true; accepted: true; clientMsgId: string; sessionId: string | null } {
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
