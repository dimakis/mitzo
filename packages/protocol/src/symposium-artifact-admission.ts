import { z } from 'zod';
import { AccountBindingSchema } from './account-binding.js';
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().positive();
const grant = z.strictObject({ grantId: id, revision });
export const ArtifactAdmissionReferenceV1Schema = z.strictObject({
  version: z.literal(1),
  transitionId: id,
  artifactGenerationId: id,
  pointerRevision: revision,
  bindingDigest: hash,
});
const commonBinding = z.strictObject({
  version: z.literal(1),
  transitionId: id,
  operationId: id,
  sessionId: id,
  workspaceId: id,
  custodyDigest: hash,
  parentGenerationId: id,
  parentSealDigest: hash,
  childGenerationId: id,
  childVolumeName: id,
  copyReceiptDigest: hash,
  expectedPointerRevision: z.number().int().nonnegative(),
  activatedPointerRevision: revision,
  workflowId: id,
  policyReservationId: id,
  seatId: id,
  actor: id,
  expectedConfigRevision: revision,
  resultingConfigRevision: revision,
  predecessorMembershipGeneration: revision,
  successorMembershipGeneration: revision,
  accountBinding: AccountBindingSchema,
  profileBinding: z.strictObject({ profileId: id, profileRevision: id }),
  contextGrant: grant,
  authorityGrant: grant,
});
const fixBinding = commonBinding.extend({
  kind: z.literal('fix').optional(),
  parentFenceId: id,
  fixAttemptId: id,
  findingFingerprints: z.array(hash).min(1).max(128),
});
const initialBinding = commonBinding.extend({
  kind: z.literal('initial'),
  sourceSealId: id,
  initialAttemptId: id,
});
export const ArtifactAdmissionBindingV1Schema = z
  .union([initialBinding, fixBinding])
  .refine(
    (v) =>
      v.resultingConfigRevision === v.expectedConfigRevision + 1 &&
      v.successorMembershipGeneration === v.predecessorMembershipGeneration + 1 &&
      v.activatedPointerRevision === v.expectedPointerRevision + 1 &&
      v.childGenerationId !== v.parentGenerationId,
    'Successor revisions must advance exactly once',
  );
export const ArtifactActivationReceiptV1Schema = z.strictObject({
  version: z.literal(1),
  transitionId: id,
  bindingDigest: hash,
  sessionId: id,
  parentGenerationId: id,
  childGenerationId: id,
  childVolumeName: id,
  expectedPointerRevision: z.number().int().nonnegative(),
  pointerRevision: revision,
  copyReceiptDigest: hash,
});
export type ArtifactAdmissionBindingV1 = z.infer<typeof ArtifactAdmissionBindingV1Schema>;
export type ArtifactAdmissionReferenceV1 = z.infer<typeof ArtifactAdmissionReferenceV1Schema>;
export type ArtifactActivationReceiptV1 = z.infer<typeof ArtifactActivationReceiptV1Schema>;
