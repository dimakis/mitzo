/** Fresh canonical launcher capabilities, passed in the same process. This is
 * not an enrollment record, IPC payload or native feature implementation.
 * Provider/configuration enrollment and original per-run native cleanup remain
 * independently required even after a new allocation has device authorization. */
export interface StagingNativeFeatureBootstrap {
  readonly sourceCommit: string;
  readonly sourceRoot: string;
  readonly fixtureRoot: string;
  assertOriginalOwnerCurrent(): void;
  /** Original retained VM owner observation. JSON cannot recreate this capability. */
  observeResources(): Readonly<{
    aggregateGiB: number;
    growthGiB: number;
    diskFreeGiB: number;
    vmMemoryMiB: 4096;
    vmCpus: 2;
    allocationUUID: string;
    planSha256: string;
    bootUUID: string;
    supervisorPid: number;
    vfkitPid: number;
    observationSha256: string;
    nativeRetirementClaim: false;
  }>;
}
