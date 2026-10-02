import { artifactDriverConfigForLease } from './symposium-artifact-lease.js';
import { createHash } from 'node:crypto';
import { artifactAdmissionDigest } from '@mitzo/protocol/event-store';
import type {
  ArtifactReaderAdmissionBindingV1,
  ArtifactReaderLeaseReceiptV1,
} from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { SqliteArtifactLeaseHost } from './symposium-artifact-host.js';

/** Existing EventStore and lease ledger own this transition. Preparation is charged first. */
export async function confirmOwnedSealedReader(
  deps: {
    store: EventStore;
    leaseHost: SqliteArtifactLeaseHost;
    /** Exact persisted ReviewStore preparation and current reviewer authority. */
    assertPreparation(binding: ArtifactReaderAdmissionBindingV1): true;
    /** A physical retained seal receipt from the selected custody. */
    requireCompletedSeal(fenceId: string): Promise<{ fenceId: string; intentDigest: string }>;
  },
  binding: ArtifactReaderAdmissionBindingV1,
) {
  const assertAuthority = (selected: ArtifactReaderAdmissionBindingV1): true => {
    if (deps.assertPreparation(selected) !== true)
      throw new Error('Charged reader preparation required');
    return true;
  };
  const seal = await deps.requireCompletedSeal(binding.sealFenceId);
  if (seal.fenceId !== binding.sealFenceId || seal.intentDigest !== binding.sealDigest)
    throw new Error('Exact completed reader seal required');
  const intent = deps.store.beginSymposiumSealedReaderAdmission(binding, assertAuthority);
  if (intent.receipt) {
    const current = deps.store.assertSymposiumSealedReaderAdmissionCurrent(
      binding.sessionId,
      intent.reference,
    );
    if (artifactAdmissionDigest(current) !== artifactAdmissionDigest(binding))
      throw new Error('Confirmed reader admission changed');
    return intent;
  }
  const lease = await deps.leaseHost.reserveSealedReaderLease(
    deps.store,
    binding,
    async (selected) => {
      assertAuthority(selected);
      const retained = await deps.requireCompletedSeal(selected.sealFenceId);
      if (
        retained.fenceId !== selected.sealFenceId ||
        retained.intentDigest !== selected.sealDigest
      )
        throw new Error('Completed reader seal changed');
      return true;
    },
  );
  const config = await artifactDriverConfigForLease(deps.leaseHost, lease);
  if (config.podman?.mounts.length !== 1 || config.podman.mounts[0].read_only !== true)
    throw new Error('Exact read-only reader mount required');
  const receipt: ArtifactReaderLeaseReceiptV1 = {
    version: 1,
    readerAdmissionId: binding.readerAdmissionId,
    bindingDigest: artifactAdmissionDigest(binding),
    sessionId: binding.sessionId,
    artifactGenerationId: binding.artifactGenerationId,
    volumeName: binding.volumeName,
    seatId: binding.seatId,
    access: 'reviewer',
    leaseTokenHash: createHash('sha256').update(lease.token).digest('hex'),
    leaseRevision: lease.revision,
    confirmedAt: Date.now(),
  };
  return deps.store.confirmSymposiumSealedReaderAdmission(binding, receipt, (selected, value) => {
    assertAuthority(selected);
    const current = deps.leaseHost
      .sealLeaseIdentities('podman', selected.volumeName)
      .find((row) => row.request.readerAdmissionId === selected.readerAdmissionId);
    if (
      !current ||
      current.request.access !== 'reviewer' ||
      current.request.sessionId !== selected.sessionId ||
      current.request.seatId !== selected.seatId ||
      current.request.volumeGeneration !== selected.artifactGenerationId ||
      current.tokenHash !== value.leaseTokenHash ||
      current.revision !== value.leaseRevision ||
      current.creationStarted
    )
      throw new Error('Exact unstarted read-only lease required');
    return true;
  });
}
