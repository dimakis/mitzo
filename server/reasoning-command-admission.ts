import { createHash } from 'node:crypto';
import type { EventStore } from './event-store.js';
import {
  deliberateSessionId,
  isDeliberationSessionId,
  parseDeliberationInput,
} from './deliberate-admission.js';
import { fusionSessionId, isFusionSessionId, parseFusionInput } from './fusion-admission.js';

/** Usage-only commands must not enter paid admission. */
export function paidReasoningCommand(name: string, args: string): boolean {
  return name === 'deliberate'
    ? !!parseDeliberationInput(args).task
    : name === 'fuse' && !!parseFusionInput(args).task;
}

export function reasoningSessionId(name: string, clientMsgId: string): string {
  return name === 'fuse' ? fusionSessionId(clientMsgId) : deliberateSessionId(clientMsgId);
}

export function isReasoningSessionId(sessionId: string): boolean {
  return isDeliberationSessionId(sessionId) || isFusionSessionId(sessionId);
}

/** Claim the original wire intent before transport-specific session normalization.
 * This is identity only: execution admissions still own replay and route checks. */
export function claimChatCommand<T extends { clientMsgId: string }>(
  store: EventStore,
  message: T,
): void {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, canonical(entry)]),
      );
    return value;
  };
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(canonical(message)))
    .digest('hex');
  // Some transport unit fixtures are partial EventStore doubles. Every production
  // EventStore owns this durable method; identity contains no persisted prompt.
  store.claimClientCommand?.(message.clientMsgId, `chat-v1:${fingerprint}`);
}
