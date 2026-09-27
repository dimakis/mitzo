import { REVIEWED_SYMPOSIUM_OWNED_RUNTIME as reviewed } from './symposium-owned-runtime-contract.js';
/** Reviewed workload identity, not a user-selected UID or a universal OpenShell default.
 * The pinned image declares OCI USER sandbox; its resolved identity was physically
 * verified as 998:998 with a credential-free container and the owned native sandbox. */
export type SymposiumArtifactOwner = { image: string; uid: number; gid: number };
export function symposiumArtifactOwner(image: string): SymposiumArtifactOwner {
  if (image !== reviewed.build.image)
    throw new Error(
      'Artifact workload image identity is not reviewed; review its UID/GID before preparing volumes',
    );
  return { image, uid: reviewed.workload.uid, gid: reviewed.workload.gid };
}
export function artifactOwnerContract(owner: SymposiumArtifactOwner): string {
  return JSON.stringify({ image: owner.image, uid: owner.uid, gid: owner.gid });
}
