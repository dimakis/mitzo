import { z } from 'zod';
import { ChatMessageTextSchema } from './chat-input-limits.js';
/** Client intent names only a message in the current conversation. */
export const MessageReplyIdSchema = z.string().min(1).max(512).regex(/^\S+$/);
/** Server-captured visible text; never a tool, reasoning or authorization payload. */
export const MessageReplyContextSchema = z.strictObject({
  messageId: MessageReplyIdSchema,
  role: z.enum(['user', 'assistant']),
  text: ChatMessageTextSchema.refine((text) => text.trim().length > 0),
  timestamp: z.number().finite().nonnegative().optional(),
});
export type MessageReplyContext = z.infer<typeof MessageReplyContextSchema>;
