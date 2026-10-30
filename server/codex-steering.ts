import { MessageReplyIdSchema } from '@mitzo/protocol';
import { z } from 'zod';
import { ChatMessageTextSchema } from '@mitzo/protocol';
export const CodexSteerInputSchema = z.strictObject({
  requestId: z.string().min(1).max(200).regex(/^\S+$/),
  targetCommandId: z.string().min(1).max(200).regex(/^\S+$/),
  replyToMessageId: MessageReplyIdSchema.optional(),
  text: ChatMessageTextSchema.refine((text) => text.trim().length > 0),
});
export type CodexSteerInput = z.infer<typeof CodexSteerInputSchema>;
export type CodexSteerStatus = 'accepted' | 'rejected' | 'uncertain';
export interface CodexSteerReceipt {
  input: CodexSteerInput;
  status: 'claimed' | CodexSteerStatus;
}
export type CodexSteerResult = { status: CodexSteerStatus | 'stale_target' };
