import { z } from 'zod';
import { ChatImagesSchema, ChatMessageTextSchema } from './chat-input-limits.js';
import { MessageReplyIdSchema } from './message-reply.js';

/** The exact correction retained by the composer and native at-most-once receipt. */
export const CodexSteerInputSchema = z.strictObject({
  requestId: z.string().min(1).max(200).regex(/^\S+$/),
  targetCommandId: z.string().min(1).max(200).regex(/^\S+$/),
  replyToMessageId: MessageReplyIdSchema.optional(),
  text: ChatMessageTextSchema.refine((text) => text.trim().length > 0),
  images: ChatImagesSchema.optional(),
});
export type CodexSteerInput = z.infer<typeof CodexSteerInputSchema>;
