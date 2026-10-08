import { artifactReaderReference } from '../symposium-artifact-reader-proof.js';
import { expect, it } from 'vitest';
import {
  ArtifactReaderAdmissionBindingV1Schema,
  ArtifactReaderLeaseReceiptV1Schema,
} from '../symposium-artifact-reader.js';
import { artifactAdmissionDigest } from '../symposium-artifact-admission-proof.js';
const hash = 'a'.repeat(64);
const binding = () => ({
  version: 1 as const,
  kind: 'sealed_reader' as const,
  readerAdmissionId: 'reader-1',
  operationId: 'review-operation',
  sessionId: 'session',
  workspaceId: 'workspace',
  custodyDigest: hash,
  sealFenceId: 'fence',
  sealDigest: hash,
  artifactGenerationId: 'generation',
  volumeName: 'artifact-volume',
  workflowId: 'workflow',
  reviewAttemptId: 'attempt',
  policyReservationId: 'reservation',
  seatId: 'reviewer',
  expectedConfigRevision: 2,
  resultingConfigRevision: 3,
  predecessorMembershipGeneration: 1,
  readerMembershipGeneration: 2,
  accountBinding: {
    provider: 'anthropic-vertex' as const,
    accountId: 'work',
    accountLabel: 'Work',
    model: 'haiku',
    profileRevision: '1',
  },
  profileBinding: { profileId: 'reviewer', profileRevision: '1' },
  contextGrant: { grantId: 'context', revision: 1 },
  authorityGrant: { grantId: 'authority', revision: 1 },
});
it('defines a distinct exact read-only reader reference without pointer movement', () => {
  const value = ArtifactReaderAdmissionBindingV1Schema.parse(binding());
  expect(artifactReaderReference(value)).toMatchObject({
    version: 1,
    kind: 'sealed_reader',
    readerAdmissionId: 'reader-1',
    artifactGenerationId: 'generation',
    bindingDigest: artifactAdmissionDigest(value),
  });
  expect(
    ArtifactReaderAdmissionBindingV1Schema.safeParse({ ...binding(), resultingConfigRevision: 2 })
      .success,
  ).toBe(false);
  expect(
    ArtifactReaderAdmissionBindingV1Schema.safeParse({
      ...binding(),
      readerMembershipGeneration: 1,
    }).success,
  ).toBe(false);
  expect(
    ArtifactReaderAdmissionBindingV1Schema.safeParse({ ...binding(), kind: 'artifact_successor' })
      .success,
  ).toBe(false);
});
it('requires a reviewer-only lease receipt bound to the exact reader admission', () => {
  const value = ArtifactReaderAdmissionBindingV1Schema.parse(binding());
  const receipt = {
    version: 1 as const,
    readerAdmissionId: 'reader-1',
    bindingDigest: artifactAdmissionDigest(value),
    sessionId: 'session',
    artifactGenerationId: 'generation',
    volumeName: 'artifact-volume',
    seatId: 'reviewer',
    access: 'reviewer' as const,
    leaseTokenHash: hash,
    leaseRevision: 'lease-1',
    confirmedAt: 1,
  };
  expect(ArtifactReaderLeaseReceiptV1Schema.parse(receipt)).toEqual(receipt);
  expect(
    ArtifactReaderLeaseReceiptV1Schema.safeParse({ ...receipt, access: 'writer' }).success,
  ).toBe(false);
  expect(
    ArtifactReaderLeaseReceiptV1Schema.safeParse({ ...receipt, volumeName: 'another' }).success,
  ).toBe(true); // identity match belongs to store/host confirmation
});
