import type { ArtifactReaderReferenceV1 } from '@mitzo/protocol';
import type { ArtifactReaderAdmissionBindingV1 } from '@mitzo/protocol';

/** Last synchronous owner fence for a sealed read-only generation. The native route
 * separately proves the actual sandbox mount and selected seat policy. */
export function assertOwnedSealedReaderCurrent(
  deps: {
    store: {
      assertSymposiumSealedReaderAdmissionCurrent(
        sessionId: string,
        reference: ArtifactReaderReferenceV1,
      ): ArtifactReaderAdmissionBindingV1;
      getSymposiumSealedReaderAdmission(
        sessionId: string,
        admissionId: string,
      ): {
        receipt: { leaseTokenHash: string; leaseRevision: string; access: 'reviewer' } | null;
      } | null;
    };
    leaseHost: {
      sealLeaseIdentities(
        driver: 'podman',
        volumeName: string,
      ): Array<{
        request: {
          readerAdmissionId?: string;
          sessionId: string;
          seatId: string;
          workspaceId: string;
          volumeName: string;
          volumeGeneration: string;
          access: string;
        };
        tokenHash: string;
        revision: string;
      }>;
    };
    workspace: string;
    custodyDigest: string;
    assertAuthority(binding: ArtifactReaderAdmissionBindingV1): true;
  },
  sessionId: string,
  reference: ArtifactReaderReferenceV1,
): void {
  const binding = deps.store.assertSymposiumSealedReaderAdmissionCurrent(sessionId, reference);
  if (
    binding.sessionId !== sessionId ||
    binding.readerAdmissionId !== reference.readerAdmissionId ||
    binding.workspaceId !== deps.workspace ||
    binding.custodyDigest !== deps.custodyDigest ||
    binding.artifactGenerationId !== reference.artifactGenerationId
  )
    throw new Error('Sealed reader custody changed');
  const receipt = deps.store.getSymposiumSealedReaderAdmission(
    sessionId,
    reference.readerAdmissionId,
  )?.receipt;
  if (!receipt || receipt.access !== 'reviewer')
    throw new Error('Confirmed read-only reader lease required');
  const matches = deps.leaseHost
    .sealLeaseIdentities('podman', binding.volumeName)
    .filter((row) => row.request.readerAdmissionId === binding.readerAdmissionId);
  if (matches.length !== 1) throw new Error('Exact read-only reader lease required');
  const lease = matches[0];
  if (
    lease.request.access !== 'reviewer' ||
    lease.request.sessionId !== sessionId ||
    lease.request.seatId !== binding.seatId ||
    lease.request.workspaceId !== deps.workspace ||
    lease.request.volumeName !== binding.volumeName ||
    lease.request.volumeGeneration !== binding.artifactGenerationId ||
    lease.tokenHash !== receipt.leaseTokenHash ||
    lease.revision !== receipt.leaseRevision
  )
    throw new Error('Exact read-only reader lease changed');
  if (deps.assertAuthority(binding) !== true)
    throw new Error('Current reader policy authority required');
}
