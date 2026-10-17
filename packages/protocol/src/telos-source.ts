import { z } from 'zod';
import {
  CollaborationSnapshotSelectionSchema,
  CollaborationSnapshotDraftSchema,
  CollaborationSnapshotMessageSchema,
} from './collaboration-conversation.js';
import { SymposiumProvenanceSchema } from './symposium.js';
import { TelosWorkIdSchema } from './telos-work-api.js';
import { TelosWorkSourceSnapshotSchema } from './telos-work.js';
import { TelosWorkCommandReceiptSchema } from './telos-work-api.js';
import { TelosOutcomeProposalSchema } from './telos-outcome.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** Actual canonical creation reply, including retained recovery/delivery metadata. */
export const TelosCanonicalOutcomeReceiptSchema = z
  .object({
    ok: z.literal(true),
    created: z.boolean(),
    item: z.object({ id: TelosWorkIdSchema, summary: z.string().min(1) }).passthrough(),
  })
  .passthrough();
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

/** Explicit whole-message/material choice in the current pending conversation.
 * Host authority supplies the source identity, purpose and fixed proposal.
 */
export const TelosSourceChoiceSchema = CollaborationSnapshotSelectionSchema.pick({
  boundary: true,
  mode: true,
  messageIds: true,
  artifacts: true,
});
export const TelosSourcePermissionOperationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('create'), outcome: TelosOutcomeProposalSchema }),
  z.strictObject({ kind: z.literal('adopt'), itemId: TelosWorkIdSchema, expectedRevision: digest }),
]);
/** Seek metadata only; this tuple is never source or operator authority. */
export const TelosSourceMaterialCursorSchema = z.strictObject({
  createdAt: z.string().min(1).max(100),
  artifactId: z.string().min(1).max(200),
  revision: z.number().int().positive().safe(),
});
export const TelosSourceMaterialMetadataSchema = z.strictObject({
  artifactId: z.string().min(1).max(200),
  revision: z.number().int().positive().safe(),
  sha256: digest,
  title: z.string(),
  filename: z.string(),
  sizeBytes: z.number().int().nonnegative().safe(),
  createdAt: z.string(),
  sessionId: z.string(),
});
export const TelosSourceMaterialPageRequestSchema = z.strictObject({
  sessionId: TelosWorkIdSchema,
  toolUseId: z.string().min(1).max(1000),
  proposalSha256: digest,
  after: TelosSourceMaterialCursorSchema.optional(),
});
export const TelosSourceMaterialPageSchema = z.strictObject({
  permId: TelosWorkIdSchema,
  sessionId: TelosWorkIdSchema,
  toolUseId: z.string().min(1).max(1000),
  proposalSha256: digest,
  artifacts: z.array(TelosSourceMaterialMetadataSchema).max(100),
  cursor: TelosSourceMaterialCursorSchema.nullable(),
  hasMore: z.boolean(),
});
export type TelosSourceMaterialCursor = z.infer<typeof TelosSourceMaterialCursorSchema>;
export type TelosSourceMaterialPageRequest = z.infer<typeof TelosSourceMaterialPageRequestSchema>;
export type TelosSourceMaterialPage = z.infer<typeof TelosSourceMaterialPageSchema>;
export const TelosSourcePermissionReviewSchema = z.strictObject({
  permId: TelosWorkIdSchema,
  sessionId: TelosWorkIdSchema,
  toolUseId: z.string().min(1).max(1000),
  expiresAt: z.number().finite().positive(),
  proposalSha256: digest,
  operation: TelosSourcePermissionOperationSchema,
  source: z.strictObject({
    conversationId: TelosWorkIdSchema,
    title: z.string().nullable(),
    boundary: CollaborationSnapshotSelectionSchema.shape.boundary,
  }),
  messages: z
    .array(
      CollaborationSnapshotMessageSchema.extend({
        attribution: TelosSourcePacketSchema.shape.attributions.valueType,
        unavailableReason: z.string().nullable(),
      }),
    )
    .max(50),
  artifacts: z.array(TelosSourceMaterialMetadataSchema).max(100),
  artifactCursor: TelosSourceMaterialCursorSchema.nullable().default(null),
  artifactsHasMore: z.boolean().default(false),
  cursor: z.number().int().nonnegative().safe(),
  hasMore: z.boolean(),
  recovery: z
    .strictObject({
      requestId: z.uuid(),
      proposalSha256: digest,
      selection: TelosSourceChoiceSchema,
      previewSha256: digest,
      preview: TelosSourcePreviewSchema,
      receipt: z.lazy(() => TelosSourcePermissionReceiptSchema).nullable(),
    })
    .optional(),
});
export const TelosSourcePermissionPreviewRequestSchema = z.strictObject({
  sessionId: TelosWorkIdSchema,
  requestId: z.uuid(),
  proposalSha256: digest,
  selection: TelosSourceChoiceSchema,
});
export const TelosSourcePermissionPreviewSchema = z.strictObject({
  permId: TelosWorkIdSchema,
  sessionId: TelosWorkIdSchema,
  requestId: z.uuid(),
  proposalSha256: digest,
  preview: TelosSourcePreviewSchema,
});
export const TelosSourcePermissionApproveRequestSchema =
  TelosSourcePermissionPreviewRequestSchema.extend({ previewSha256: digest });
export const TelosSourcePermissionReceiptSchema = z.strictObject({
  permId: TelosWorkIdSchema,
  sessionId: TelosWorkIdSchema,
  receipt: TelosWorkCommandReceiptSchema,
  sourceSnapshotId: TelosWorkIdSchema,
  canonicalCreation: TelosCanonicalOutcomeReceiptSchema.nullable().optional(),
});
export type TelosCanonicalOutcomeReceipt = z.infer<typeof TelosCanonicalOutcomeReceiptSchema>;
export type TelosSourceChoice = z.infer<typeof TelosSourceChoiceSchema>;
export type TelosSourcePermissionReview = z.infer<typeof TelosSourcePermissionReviewSchema>;
export type TelosSourcePermissionOperation = z.infer<typeof TelosSourcePermissionOperationSchema>;
export type TelosSourcePermissionPreviewRequest = z.infer<
  typeof TelosSourcePermissionPreviewRequestSchema
>;
export type TelosSourcePermissionPreview = z.infer<typeof TelosSourcePermissionPreviewSchema>;
export type TelosSourcePermissionApproveRequest = z.infer<
  typeof TelosSourcePermissionApproveRequestSchema
>;
export type TelosSourcePermissionReceipt = z.infer<typeof TelosSourcePermissionReceiptSchema>;
