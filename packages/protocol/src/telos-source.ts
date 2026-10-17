import { z } from 'zod';
import {
  CollaborationSnapshotSelectionSchema,
  CollaborationSnapshotDraftSchema,
} from './collaboration-conversation.js';
import { SymposiumProvenanceSchema } from './symposium.js';
import { TelosWorkIdSchema } from './telos-work-api.js';
import { TelosWorkSourceSnapshotSchema } from './telos-work.js';
import { TelosOutcomeProposalSchema } from './telos-outcome.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const TelosSourcePreviewRequestSchema = z.strictObject({
  itemId: TelosWorkIdSchema,
  selection: CollaborationSnapshotSelectionSchema,
});
/** A host-compiled review packet, never accepted as capture proof from HTTP.
 * The source compiler owns public bytes, bounds and immutable artifact pins.
 */
export const TelosSourcePacketSchema = z.strictObject({
  version: z.literal(1),
  actorId: z.string().min(1),
  itemId: TelosWorkIdSchema.nullable(),
  workRevision: digest,
  selection: CollaborationSnapshotSelectionSchema,
  brief: z.strictObject({ sha256: digest, text: z.string() }),
  context: CollaborationSnapshotDraftSchema,
  attributions: z.record(
    z.string(),
    z.strictObject({
      seatId: z.string().nullable(),
      provenance: SymposiumProvenanceSchema.nullable(),
      createdAt: z.number().finite().nonnegative(),
    }),
  ),
  sourceTitle: z.string().nullable(),
  sourceCreatedAt: z.string().min(1).nullable(),
  creation: z
    .strictObject({ requestId: TelosWorkIdSchema, outcome: TelosOutcomeProposalSchema })
    .optional(),
});
export const TelosSourceNewPreviewRequestSchema = z.strictObject({
  requestId: TelosWorkIdSchema,
  outcome: TelosOutcomeProposalSchema,
  selection: CollaborationSnapshotSelectionSchema,
});
export const TelosSourceCreateRequestSchema = TelosSourceNewPreviewRequestSchema.extend({
  previewSha256: digest,
});
export const TelosSourcePreviewSchema = z.strictObject({
  sha256: digest,
  packet: TelosSourcePacketSchema,
});
export const TelosSourceAdoptRequestSchema = TelosSourcePreviewRequestSchema.extend({
  requestId: TelosWorkIdSchema,
  expectedRevision: digest,
  previewSha256: digest,
});
export const TelosReviewedSourceViewSchema = z.strictObject({
  snapshot: TelosWorkSourceSnapshotSchema,
  packet: TelosSourcePacketSchema,
  sourceHref: z.string().startsWith('/chat/'),
  available: z.boolean(),
});
export type TelosSourcePacket = z.infer<typeof TelosSourcePacketSchema>;
export type TelosSourcePreviewRequest = z.infer<typeof TelosSourcePreviewRequestSchema>;
export type TelosSourcePreview = z.infer<typeof TelosSourcePreviewSchema>;
export type TelosSourceAdoptRequest = z.infer<typeof TelosSourceAdoptRequestSchema>;
export type TelosSourceNewPreviewRequest = z.infer<typeof TelosSourceNewPreviewRequestSchema>;
export type TelosSourceCreateRequest = z.infer<typeof TelosSourceCreateRequestSchema>;
