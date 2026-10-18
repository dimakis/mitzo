import { z } from 'zod';
import { TelosWorkRoleContextSelectionSchema } from './telos-work-role-context.js';
import { TelosWorkIdSchema, TelosWorkRoleSetupInputSchema } from './telos-work-api.js';
import { TelosWorkArtifactReferenceSchema } from './telos-work.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const label = z.string().min(1);
const item = z.strictObject({ itemId: TelosWorkIdSchema, revision: label, title: z.string() });
export const TelosWorkRolePresentationRefSchema = z.strictObject({ id: z.uuid(), sha256: digest });
/** Human labels are immutable display data, not role/task authority. */
export const TelosWorkRolePresentationSchema = z.strictObject({
  version: z.literal(1),
  contextSha256: digest,
  reviewedAt: label,
  item,
  overallGoal: item,
  parents: z.array(item),
  sources: z.array(
    z.strictObject({
      snapshotId: TelosWorkIdSchema,
      title: z.string().nullable(),
      createdAt: label.nullable(),
    }),
  ),
  artifacts: z.array(
    TelosWorkArtifactReferenceSchema.extend({
      filename: label,
      title: z.string(),
      createdAt: label,
      sourceKind: z
        .enum([
          'user_upload',
          'user_edit',
          'session_artifact',
          'external_codex_report',
          'source_capture',
        ])
        .optional(),
    }),
  ),
});
export const TelosWorkRoleContextReviewSchema = z
  .strictObject({
    version: z.literal(1),
    selection: TelosWorkRoleContextSelectionSchema,
    presentationRef: TelosWorkRolePresentationRefSchema,
    presentation: TelosWorkRolePresentationSchema,
  })
  .superRefine(({ selection, presentation }, context) => {
    const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const identity = (value: { itemId: string; revision: string }) => ({
      itemId: value.itemId,
      revision: value.revision,
    });
    const artifacts = [
      ...new Map(
        [...selection.artifacts, ...selection.sources.flatMap((source) => source.artifacts)].map(
          (pin) => [JSON.stringify(pin), pin],
        ),
      ).values(),
    ];
    if (
      !equal(identity(presentation.item), {
        itemId: selection.itemId,
        revision: selection.brief.revision,
      }) ||
      !equal(identity(presentation.overallGoal), identity(selection.overallGoal)) ||
      !equal(presentation.parents.map(identity), selection.parentCriteria.map(identity)) ||
      !equal(
        presentation.sources.map((source) => source.snapshotId),
        selection.sources.map((source) => source.snapshotId),
      ) ||
      !equal(
        presentation.artifacts.map(({ artifactId, revision, sha256 }) => ({
          artifactId,
          revision,
          sha256,
        })),
        artifacts,
      )
    )
      context.addIssue({
        code: 'custom',
        message: 'Presentation belongs to a different reviewed selection',
      });
  });
export const TelosWorkReviewedRoleSetupInputSchema = z.strictObject({
  version: z.literal(1),
  input: TelosWorkRoleSetupInputSchema,
  presentationRef: TelosWorkRolePresentationRefSchema,
});
export type TelosWorkRolePresentationRef = z.infer<typeof TelosWorkRolePresentationRefSchema>;
export type TelosWorkRolePresentation = z.infer<typeof TelosWorkRolePresentationSchema>;
export type TelosWorkRoleContextReview = z.infer<typeof TelosWorkRoleContextReviewSchema>;
export type TelosWorkReviewedRoleSetupInput = z.infer<typeof TelosWorkReviewedRoleSetupInputSchema>;
