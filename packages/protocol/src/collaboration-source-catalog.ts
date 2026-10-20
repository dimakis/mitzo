import { z } from 'zod';
import {
  CollaborationInlineArtifactPinSchema,
  CollaborationRetainedArtifactMetadataSchema,
  CollaborationRetainedArtifactPinSchema,
  CollaborationSnapshotSelectionSchema,
  CollaborationDurableTranscriptSchema,
} from './collaboration-conversation.js';
import { CollaborationSourceSetupQuerySchema } from './collaboration-source-setup.js';
import { TelosSourceMaterialCursorSchema } from './telos-source.js';

/** Observational selectors only. No item, permission, bytes or target authority. */
export const CollaborationSourceCatalogRequestSchema = CollaborationSourceSetupQuerySchema.extend({
  artifactsAfter: TelosSourceMaterialCursorSchema.optional(),
});
export const CollaborationSourceCatalogSchema = z
  .strictObject({
    sourceConversationId: CollaborationSourceSetupQuerySchema.shape.sourceConversationId,
    boundary: CollaborationSnapshotSelectionSchema.shape.boundary,
    messages: CollaborationDurableTranscriptSchema.shape.messages,
    artifacts: z
      .array(
        z.union([
          CollaborationInlineArtifactPinSchema.extend({
            title: z.string().min(1).max(1000),
            filename: z.string().min(1).max(1000).optional(),
          }),
          CollaborationRetainedArtifactMetadataSchema,
        ]),
      )
      .max(300),
    artifactCursor: TelosSourceMaterialCursorSchema.nullable(),
    artifactHasMore: z.boolean(),
    retainedAvailability: z.enum(['available', 'unavailable']),
    unversionedRetainedReferences: z.boolean(),
    /** Intent from the source's actual repository claim, never target access. */
    sourceRepository: z.strictObject({ repository: z.string().min(3).max(256) }).nullable(),
  })
  .refine(
    (value) => value.artifactHasMore === (value.artifactCursor !== null),
    'Artifact cursor changed',
  )
  .refine(
    (value) =>
      CollaborationDurableTranscriptSchema.safeParse({
        sourceConversationId: value.sourceConversationId,
        boundary: value.boundary,
        messages: value.messages,
      }).success,
    'Source transcript changed',
  );
export type CollaborationSourceCatalog = z.infer<typeof CollaborationSourceCatalogSchema>;
export const CollaborationSourceArtifactVersionsRequestSchema =
  CollaborationSourceSetupQuerySchema.extend({
    boundary: CollaborationSnapshotSelectionSchema.shape.boundary,
    artifact: CollaborationRetainedArtifactPinSchema,
    beforeRevision: z.number().int().positive().safe().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  });
export const CollaborationSourceArtifactVersionsSchema = z
  .strictObject({
    sourceConversationId: CollaborationSourceSetupQuerySchema.shape.sourceConversationId,
    boundary: CollaborationSnapshotSelectionSchema.shape.boundary,
    artifacts: z.array(CollaborationRetainedArtifactMetadataSchema).max(50),
    cursor: z.number().int().positive().safe().nullable(),
    hasMore: z.boolean(),
  })
  .refine((value) => value.hasMore === (value.cursor !== null), 'Revision cursor changed');
