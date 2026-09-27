import { artifactAdmissionDigest } from './event-store.js';
import { type ArtifactAdmissionBindingV1 } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { canonicalReviewJson, reviewRecordHash } from './symposium-review-records.js';
import {
  SymposiumArtifactGenerations,
  type ArtifactGenerationRequest,
  type InitialArtifactGeneration,
} from './symposium-artifact-generations.js';
import { PhysicalArtifactSuccessorCopier } from './symposium-artifact-successor-copy.js';
import {
  assertSuccessorFixAuthority,
  type SuccessorFixAuthority,
} from './symposium-artifact-successor-authority.js';
import type {
  PhysicalArtifactSealer,
  SuccessorArtifactExportReceipt,
} from './symposium-physical-artifact-seal.js';
import type { SymposiumSessionArtifacts } from './symposium-session-artifacts.js';
import type { OwnedSymposiumGateway } from './symposium-owned-gateway.js';
import type { SqliteArtifactLeaseHost } from './symposium-artifact-host.js';
const digest = (value: unknown) => reviewRecordHash(canonicalReviewJson(value));
/** One owned operation composes existing stores. No queue, model dispatch or writer admission. */
export async function withOwnedArtifactSuccessor<T>(
  deps: {
    authority?: SuccessorFixAuthority;
    gateway: OwnedSymposiumGateway;
    leaseHost: SqliteArtifactLeaseHost;
    sessionArtifacts: SymposiumSessionArtifacts;
    sealer: PhysicalArtifactSealer;
  },
  request: ArtifactGenerationRequest,
  exported: SuccessorArtifactExportReceipt,
  bundle: Buffer,
  run: (
    copier: PhysicalArtifactSuccessorCopier,
    ledger: SymposiumArtifactGenerations,
  ) => Promise<T>,
): Promise<T> {
  assertSuccessorFixAuthority(deps.authority, request);
  deps.leaseHost.requireSnapshotGateway(deps.gateway);
  const custodyDigest = createHash('sha256').update(deps.gateway.stateDirectory).digest('hex');
  if (request.workspace !== deps.gateway.workspace || request.custodyDigest !== custodyDigest)
    throw new Error('Successor gateway custody changed');
  deps.sealer.assertRetainedSuccessorExport(exported, bundle);
  const db = new Database(deps.leaseHost.snapshotDatabasePath());
  try {
    const initial = (): InitialArtifactGeneration => {
      const receipt = deps.sessionArtifacts.initializationReceipt(request.sessionId);
      if (!receipt) throw new Error('Retained initial artifact receipt unavailable');
      return {
        sessionId: request.sessionId,
        workspace: deps.gateway.workspace,
        custodyDigest,
        generationId: receipt.mapping.volumeGeneration,
        volumeName: receipt.mapping.volumeName,
        initializationReceiptDigest: digest(receipt),
      };
    };
    const ledger: SymposiumArtifactGenerations = new SymposiumArtifactGenerations(db, {
      initial(value) {
        if (canonicalReviewJson(value) !== canonicalReviewJson(initial()))
          throw new Error('Initial artifact identity changed');
        return true;
      },
      authority(value) {
        deps.gateway.verifyCustody();
        return assertSuccessorFixAuthority(deps.authority, value);
      },
      parent(intent, parent) {
        deps.gateway.verifyCustody();
        deps.sealer.assertRetainedSuccessorExport(exported, bundle);
        if (
          parent.generationId !== exported.parentGenerationId ||
          parent.volumeName !== exported.parentVolumeName ||
          intent.request.parentGenerationId !== exported.parentGenerationId ||
          intent.request.parentSealDigest !== exported.parentSealDigest ||
          intent.request.exportReceiptDigest !== digest(exported)
        )
          throw new Error('Retained successor parent changed');
        return true;
      },
      copy(intent, receipt): true {
        return copier.assertCopyReceipt(intent, receipt);
      },
    });
    ledger.registerInitial(initial());
    const copier: PhysicalArtifactSuccessorCopier = new PhysicalArtifactSuccessorCopier({
      ledger,
      sealer: deps.sealer,
      command: deps.leaseHost.snapshotCommand(),
      custody: () => deps.gateway.verifyCustodyAsync(),
    });
    return await run(copier, ledger);
  } finally {
    db.close();
  }
}

/** Completes the existing two-owner handshake; an intent or pointer alone never admits. */
export function confirmOwnedArtifactSuccessor(
  store: EventStore,
  ledger: SymposiumArtifactGenerations,
  binding: ArtifactAdmissionBindingV1,
  assertAuthority: (binding: ArtifactAdmissionBindingV1) => true,
) {
  const intent = store.beginSymposiumArtifactAdmission(binding, assertAuthority);
  const receipt = ledger.activateAdmission(binding, (selected) => {
    assertAuthority(selected);
    const retained = store.getSymposiumArtifactAdmission(selected.sessionId, selected.transitionId);
    if (
      !retained ||
      artifactAdmissionDigest(retained.binding) !== artifactAdmissionDigest(selected)
    )
      throw new Error('Retained successor intent changed');
    return true;
  });
  return store.confirmSymposiumArtifactAdmission(intent.binding, receipt, (selected, value) => {
    assertAuthority(selected);
    if (
      artifactAdmissionDigest(ledger.requireAdmission(selected)) !== artifactAdmissionDigest(value)
    )
      throw new Error('Successor activation changed');
    return true;
  });
}
