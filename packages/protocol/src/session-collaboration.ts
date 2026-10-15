import { z } from 'zod';

export const SessionCollaborationIdSchema = z.uuid();
const sessionId = z.string().min(1).max(200).regex(/^\S+$/);
const participants = z
  .array(sessionId)
  .max(16)
  .refine((ids) => new Set(ids).size === ids.length, 'Duplicate participant');

/** Relationship identity only: neither a conversation, work item nor execution grant. */
export const SessionCollaborationSchema = z.strictObject({
  version: z.literal(1),
  collaborationId: SessionCollaborationIdSchema,
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  participantSessionIds: participants,
});
export const SessionCollaborationUpdateSchema = z.strictObject({
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  participantSessionIds: participants,
});
export const SessionCollaborationListQuerySchema = z.strictObject({
  sessionId,
  after: SessionCollaborationIdSchema.optional(),
});
export type SessionCollaboration = z.infer<typeof SessionCollaborationSchema>;
export class SessionCollaborationError extends Error {
  constructor(readonly code: 'not_found' | 'conflict' | 'invalid_membership') {
    super(
      code === 'not_found'
        ? 'Conversation not found'
        : code === 'conflict'
          ? 'Collaboration changed'
          : 'Start collaboration with at least two existing sessions',
    );
  }
}
