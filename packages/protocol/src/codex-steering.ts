import { z } from 'zod';
import { ChatImagesSchema, ChatMessageTextSchema } from './chat-input-limits.js';
import { MessageReplyIdSchema } from './message-reply.js';
import type { SessionRuntimeBinding } from './session-runtime-binding.js';

/** Public command state survives transcript restore even without a user row
 * (for example an internal repository continuation). No provider IDs or input. */
export const TranscriptCommandStateSchema = z.strictObject({
  messageId: z.string().min(1).max(200),
  state: z.enum([
    'sending',
    'queued',
    'running',
    'completed',
    'ended',
    'interrupted',
    'failed',
    'cancelled',
    'steering',
    'steered',
    'uncertain',
  ]),
  seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type TranscriptCommandState = z.infer<typeof TranscriptCommandStateSchema>;

/** The exact correction retained by the composer and native at-most-once receipt. */
export const CodexSteerInputSchema = z.strictObject({
  requestId: z.string().min(1).max(200).regex(/^\S+$/),
  targetCommandId: z.string().min(1).max(200).regex(/^\S+$/),
  replyToMessageId: MessageReplyIdSchema.optional(),
  text: ChatMessageTextSchema.refine((text) => text.trim().length > 0),
  images: ChatImagesSchema.optional(),
});
export type CodexSteerInput = z.infer<typeof CodexSteerInputSchema>;

/** Route support only. Current operator custody, query and target are checked at
 * submission and again by the native input owner immediately before dispatch. */
export function supportsUserTurnSteering(
  binding: SessionRuntimeBinding | null | undefined,
): boolean {
  return (
    !!binding &&
    (binding.harness.implementation === 'codex' ||
      (binding.version === 2 &&
        binding.harness.implementation === 'claude-sdk' &&
        binding.execution.location === 'local'))
  );
}
