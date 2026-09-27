import { createHash } from 'node:crypto';
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
export const ArtifactAdmissionBindingV1Schema = z
  .strictObject({
    version: z.literal(1),
    transitionId: id,
    operationId: id,
    sessionId: id,
    workspaceId: id,
    custodyDigest: hash,
    parentGenerationId: id,
    parentFenceId: id,
    parentSealDigest: hash,
    childGenerationId: id,
    childVolumeName: id,
    copyReceiptDigest: hash,
    expectedPointerRevision: z.number().int().nonnegative(),
    activatedPointerRevision: revision,
    workflowId: id,
    fixAttemptId: id,
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
    findingFingerprints: z.array(hash).min(1).max(128),
  })
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
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(
          (key) => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key]),
        )
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export function artifactAdmissionDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function artifactAdmissionReference(
  binding: ArtifactAdmissionBindingV1,
): ArtifactAdmissionReferenceV1 {
  return {
    version: 1,
    transitionId: binding.transitionId,
    artifactGenerationId: binding.childGenerationId,
    pointerRevision: binding.activatedPointerRevision,
    bindingDigest: artifactAdmissionDigest(binding),
  };
}
