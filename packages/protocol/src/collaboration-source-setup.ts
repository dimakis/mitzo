import { z } from 'zod';
import { CollaborationBeginSchema } from './collaboration-conversation.js';
import { SessionCollaborationSchema } from './session-collaboration.js';

export const CollaborationSourceSetupQuerySchema = z.strictObject({
  sourceConversationId: CollaborationBeginSchema.shape.sessionId,
  clientId: z.string().min(1).max(200).regex(/^\S+$/),
});
const source = { sourceConversationId: CollaborationBeginSchema.shape.sessionId };
/** Relationship selection only; never source access, allocation or execution authority. */
export const CollaborationSourceSetupSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('unstarted'), ...source }),
  z.strictObject({
    state: z.literal('selected'),
    ...source,
    collaboration: SessionCollaborationSchema,
  }),
  z.strictObject({
    state: z.literal('unavailable'),
    ...source,
    reason: z.enum(['multiple_associations', 'origin_unverified', 'foreign_origin']),
  }),
]);
export type CollaborationSourceSetup = z.infer<typeof CollaborationSourceSetupSchema>;
