/** Fresh canonical launcher capabilities, passed in the same process. This is
 * not an enrollment record, IPC payload or native feature implementation.
 * Provider/configuration enrollment and original per-run native cleanup remain
 * independently required even after a new allocation has device authorization. */
export interface StagingNativeFeatureBootstrap {
  readonly sourceCommit: string;
  readonly sourceRoot: string;
  readonly fixtureRoot: string;
  assertOriginalOwnerCurrent(): void;
  assertFreshEnrollmentCurrent(): void;
}
