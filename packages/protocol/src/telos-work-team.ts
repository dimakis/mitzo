import { z } from 'zod';
import { TelosWorkIdSchema } from './telos-work-api.js';

const id = TelosWorkIdSchema;
const revision = z.string().regex(/^[a-f0-9]{64}$/);
export const TelosTeamRoleSchema = z.enum([
  'orchestrator',
  'feature_lead',
  'slice_owner',
  'investigator',
  'implementer',
  'reviewer',
  'merge_agent',
  'contributor',
]);
const selection = {
  conversationId: id,
  displayName: z.string().trim().min(1).max(240),
  role: TelosTeamRoleSchema,
  responsibility: z.string().trim().min(1).max(500),
  reportsToMembershipId: id.nullable(),
};
/** Explicit operational responsibility, separate from reviewed runtime roles.
 * Membership grants no item/transcript access, execution or account authority. */
export const TelosTeamMembershipSchema = z
  .strictObject({
    ...selection,
    membershipId: z.uuid(),
    state: z.enum(['current', 'former']),
    linkedAt: z.iso.datetime(),
    linkedBy: id,
    endedAt: z.iso.datetime().nullable(),
    endedBy: id.nullable(),
    operationId: z.uuid(),
    replacedByMembershipId: z.uuid().nullable(),
  })
  .refine(
    (member) =>
      member.state === 'current'
        ? member.endedAt === null &&
          member.endedBy === null &&
          member.replacedByMembershipId === null
        : member.endedAt !== null && member.endedBy !== null,
    'Invalid membership transition',
  );
export const TelosTeamViewSchema = z.strictObject({
  itemId: id,
  revision,
  members: z.array(TelosTeamMembershipSchema),
});
const command = { itemId: id, requestId: id, expectedRevision: revision };
export const TelosTeamCommandSchema = z.discriminatedUnion('operation', [
  z.strictObject({ ...command, operation: z.literal('link'), ...selection }),
  z.strictObject({ ...command, operation: z.literal('unlink'), membershipId: id }),
  z.strictObject({ ...command, operation: z.literal('replace'), membershipId: id, ...selection }),
]);
export const TelosTeamReceiptSchema = z.strictObject({
  requestId: id,
  commandId: z.uuid(),
  actorId: id,
  team: TelosTeamViewSchema,
});
export type TelosTeamMembership = z.infer<typeof TelosTeamMembershipSchema>;
export type TelosTeamView = z.infer<typeof TelosTeamViewSchema>;
export type TelosTeamCommand = z.infer<typeof TelosTeamCommandSchema>;
export type TelosTeamReceipt = z.infer<typeof TelosTeamReceiptSchema>;
