import type { AccountBinding } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { NativeResponsesStore } from './native-responses-store.js';
import { hasPersistentRevocationAuthority, type AuthSession } from './auth.js';
import type { readCodexQueue } from './codex-chat-session.js';
type QueueStatus = NonNullable<ReturnType<typeof readCodexQueue>>;
/** Metadata reads native scheduling identities, never provider transcript/images. */
export function readOwnedResponsesQueue(
  events: EventStore,
  native: NativeResponsesStore,
  id: string,
  binding: AccountBinding,
  connected: boolean,
): QueueStatus {
  try {
    const queue = native.queue(id, binding),
      status = native.status(id, binding);
    const selection = events.getLatestOrdinaryCommandAdmission(id)?.selection;
    return {
      paused: queue.paused || !connected,
      connected,
      recovering: false,
      queued: queue.queued.length,
      interrupted: status === 'interrupted' ? 1 : 0,
      failed: 0,
      retryable: false,
      model: selection?.model ?? binding.model,
      reasoningEffort: selection?.thinking,
    };
  } catch {
    return {
      paused: true,
      connected: false,
      recovering: false,
      queued: 0,
      interrupted: 0,
      failed: 0,
      retryable: false,
    };
  }
}
export function readOwnedResponsesQueueOverview(
  events: EventStore,
  native: NativeResponsesStore,
  id: string,
  binding: AccountBinding,
) {
  const queue = native.queue(id, binding);
  return {
    queued: queue.queued.map((commandId) => ({
      id: commandId,
      preview: events.ordinaryCommandPreview(commandId, id) ?? '',
    })),
    cancelledIds: queue.cancelledIds,
    hasMore: false,
  };
}
export function cancelOwnedResponsesQueuedCommand(
  events: EventStore,
  native: NativeResponsesStore,
  id: string,
  binding: AccountBinding,
  commandId: string,
  authorization?: AuthSession,
) {
  const custody = native.readOrdinaryCustody(id, binding);
  if (
    !authorization ||
    !hasPersistentRevocationAuthority() ||
    custody?.authSessionId !== authorization.id
  )
    throw Error('Original signed operator required');
  // Uncertain admissions are retained for explicit outcome recovery; cancellation
  // only removes positively consumed, never-provider-attempted queued work.
  if (
    events.getOrdinaryLocalResponsesCommandAdmission(commandId)?.state !== 'consumed' ||
    events.getExecutionAdmission(id, commandId)
  )
    return 'not_queued' as const;
  return native.cancelQueuedCommand(id, binding, commandId);
}
