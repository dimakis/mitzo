import { z } from 'zod';
import { AccountBindingSchema } from './account-binding.js';
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().positive();
const grant = z.strictObject({ grantId: id, revision: positive });
/** A reviewer transition on the retained sealed generation. It never changes the artifact pointer. */
export const ArtifactReaderAdmissionBindingV1Schema = z
  .strictObject({
    version: z.literal(1),
    kind: z.literal('sealed_reader'),
    readerAdmissionId: id,
    operationId: id,
    sessionId: id,
    workspaceId: id,
    custodyDigest: hash,
    sealFenceId: id,
    sealDigest: hash,
    artifactGenerationId: id,
    volumeName: id,
    workflowId: id,
    reviewAttemptId: id,
    policyReservationId: id,
    seatId: id,
    expectedConfigRevision: positive,
    resultingConfigRevision: positive,
    predecessorMembershipGeneration: positive,
    readerMembershipGeneration: positive,
    accountBinding: AccountBindingSchema,
    profileBinding: z.strictObject({ profileId: id, profileRevision: id }),
    contextGrant: grant,
    authorityGrant: grant,
  })
  .refine(
    (v) =>
      v.resultingConfigRevision === v.expectedConfigRevision + 1 &&
      v.readerMembershipGeneration === v.predecessorMembershipGeneration + 1,
    'Reader revisions must advance exactly once',
  );
export const ArtifactReaderLeaseReceiptV1Schema = z.strictObject({
  version: z.literal(1),
  readerAdmissionId: id,
  bindingDigest: hash,
  sessionId: id,
  artifactGenerationId: id,
  volumeName: id,
  seatId: id,
  access: z.literal('reviewer'),
  leaseTokenHash: hash,
  leaseRevision: id,
  confirmedAt: z.number().int().nonnegative(),
});
export const ArtifactReaderReferenceV1Schema = z.strictObject({
  version: z.literal(1),
  kind: z.literal('sealed_reader'),
  readerAdmissionId: id,
  artifactGenerationId: id,
  sealFenceId: id,
  bindingDigest: hash,
});
export type ArtifactReaderAdmissionBindingV1 = z.infer<
  typeof ArtifactReaderAdmissionBindingV1Schema
>;
export type ArtifactReaderLeaseReceiptV1 = z.infer<typeof ArtifactReaderLeaseReceiptV1Schema>;
export type ArtifactReaderReferenceV1 = z.infer<typeof ArtifactReaderReferenceV1Schema>;
