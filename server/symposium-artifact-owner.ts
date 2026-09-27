import { reviewedSymposiumOwnedRuntime } from './symposium-owned-runtime-contract.js';
/** Reviewed workload identity, not a user-selected UID or a universal OpenShell default.
 * The pinned image declares OCI USER sandbox; its resolved identity was physically
 * verified as 998:998 with a credential-free container and the owned native sandbox. */
export type SymposiumArtifactOwner = { image: string; uid: number; gid: number };
export function symposiumArtifactOwner(image: string): SymposiumArtifactOwner {
  const reviewed = reviewedSymposiumOwnedRuntime(image);
  return { image, uid: reviewed.workload.uid, gid: reviewed.workload.gid };
}
export function artifactOwnerContract(owner: SymposiumArtifactOwner): string {
  return JSON.stringify({ image: owner.image, uid: owner.uid, gid: owner.gid });
}
