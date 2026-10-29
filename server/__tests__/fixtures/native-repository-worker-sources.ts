/** Exact standalone ESM fixture closure. The same inventory drives compilation,
 * provenance hashes and the ungated module-load smoke test. */
export const nativeRepositoryFixtureWorkerSources = [
  'sandboxed-command-worker.ts',
  'sandbox-authority.ts',
  'native-file-operation.ts',
  'native-preparation-observation.ts',
  'native-preparation-publication.ts',
  'native-repository-observation.ts',
  'native-repository-topology.ts',
  'native-tree-publication.ts',
  'private-repository-checkout.ts',
  'local-repository-base.ts',
  'local-repository-host-git.ts',
  'git-branch.ts',
  'repository-git-container-policy.ts',
] as const;
