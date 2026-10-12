import type { AccountProfiles } from './account-profiles.js';
import type { InitialSourceExportReceipt } from './symposium-source-artifact-seal.js';
import type {
  ArtifactGenerationRequest,
  ArtifactGenerationCopyReceipt,
} from './symposium-artifact-generations.js';
import type { ArtifactAdmissionBindingV1, ArtifactAdmissionReferenceV1 } from '@mitzo/protocol';
import type {
  PhysicalArtifactSealInput,
  CompletedArtifactSeal,
  SuccessorArtifactExportReceipt,
} from './symposium-physical-artifact-seal.js';
import type { CompletedPublicationHost } from './symposium-publication-artifact.js';
import type { SymposiumAttemptRegistry } from './symposium-attempt-registry.js';
import type { SqliteArtifactLeaseHost } from './symposium-artifact-host.js';
import type { SymposiumInteractiveReviewHost } from './symposium-review-routes.js';
import type { ReviewPublicationDependencies } from './symposium-review-publication.js';

/** Trusted capabilities consumed by physical review composition. This contract
 * owns no runtime, credential, database, provider or artifact lifecycle. */
export interface SymposiumReviewPhysicalHost {
  sourceImport?: import('./symposium-source-service.js').SymposiumSourceHost & {
    requireSeal?(
      sessionId: string,
    ): ReturnType<
      typeof import('./symposium-source-artifact-seal.js').requireCompletedImportedSourceSeal
    >;
    initialExport?(
      sessionId: string,
      operationId: string,
    ): { receipt: InitialSourceExportReceipt; bundle: Buffer };
  };
  gateway?: { workspace: string };
  sealSessionArtifacts?(
    input: PhysicalArtifactSealInput,
    runtime: object,
    signal: AbortSignal,
  ): Promise<CompletedArtifactSeal>;
  recoverPendingArtifactSeal?(
    input: PhysicalArtifactSealInput,
    claimToken: string,
    signal: AbortSignal,
  ): Promise<CompletedArtifactSeal>;
  exportSuccessorArtifactBundle?(
    input: {
      fenceId: string;
      operationId: string;
      sourceBranch: string;
      baseBranch: string;
      sourceOid: string;
      maxBytes: number;
    },
    signal: AbortSignal,
  ): Promise<{ receipt: SuccessorArtifactExportReceipt; bundle: Buffer }>;
  copySuccessorArtifact?(
    request: ArtifactGenerationRequest,
    exported: InitialSourceExportReceipt | SuccessorArtifactExportReceipt,
    bundle: Buffer,
    signal: AbortSignal,
  ): Promise<ArtifactGenerationCopyReceipt>;
  admitSuccessorArtifact?(
    request: ArtifactGenerationRequest,
    binding: ArtifactAdmissionBindingV1,
    exported: InitialSourceExportReceipt | SuccessorArtifactExportReceipt,
    bundle: Buffer,
    signal: AbortSignal,
  ): Promise<{ reference: ArtifactAdmissionReferenceV1; receipt: unknown }>;
  inspectStoppedSuccessorOperation?(selected: {
    sessionId: string;
    transitionId: string;
    workflowId: string;
    attemptId: string;
    kind: 'initial' | 'fix';
  }): 'absent' | 'reserved' | 'copy_uncertain' | 'quarantined' | 'verified' | 'active' | null;
  requireCompletedArtifactSeal?: CompletedPublicationHost['requireCompletedArtifactSeal'];
  inspectCompletedArtifact?: CompletedPublicationHost['inspectCompletedArtifact'];
  exportCompletedReviewContext?: import('./symposium-physical-artifact-seal.js').PhysicalArtifactSealer['exportCompletedReviewContext'];
  releaseCompletedReviewStream?: import('./symposium-physical-artifact-seal.js').PhysicalArtifactSealer['releaseCompletedReviewStream'];
  releaseReadyReviewStream?: import('./symposium-physical-artifact-seal.js').PhysicalArtifactSealer['releaseReadyReviewStream'];
  releaseStoppedReadyReviewStream?: import('./symposium-physical-artifact-seal.js').PhysicalArtifactSealer['releaseStoppedReadyReviewStream'];
  trackApplicationTransition?<T>(operation: () => Promise<T>): Promise<T>;
  checkCompletedArtifactFile?: import('./symposium-physical-artifact-seal.js').PhysicalArtifactSealer['checkCompletedArtifactFile'];
  reconcileCompletedArtifactSemantic?: import('./symposium-physical-artifact-seal.js').PhysicalArtifactSealer['reconcileCompletedArtifactSemantic'];
  getCompletedArtifactSemanticCheckState?: import('./symposium-physical-artifact-seal.js').PhysicalArtifactSealer['getCompletedArtifactSemanticCheckState'];
  checkCompletedArtifactSemantic?: import('./symposium-physical-artifact-seal.js').PhysicalArtifactSealer['checkCompletedArtifactSemantic'];
  criterionChecks?: readonly import('./symposium-criterion-receipts.js').CheckDefinition[];
  currentProfiles: () => AccountProfiles;
  attemptRegistry: SymposiumAttemptRegistry;
  assertArtifactAdmissionCurrent?: (
    sessionId: string,
    reference:
      | import('@mitzo/protocol').ArtifactAdmissionReferenceV1
      | import('@mitzo/protocol').ArtifactReaderReferenceV1,
  ) => void;
  artifactLeaseHost: SqliteArtifactLeaseHost;
}

/** Optional until trusted review and publication bindings are installed. */
export interface SymposiumReviewRouteHost {
  reviewHost?: SymposiumInteractiveReviewHost;
  reviewPublication?: Omit<ReviewPublicationDependencies, 'store'>;
}
