/** Reviewed workload identity, not a user-selected UID or a universal OpenShell default.
 * The pinned image declares OCI USER sandbox; its resolved identity was physically
 * verified as 998:998 with a credential-free container and the owned native sandbox. */
const reviewedOwners: Readonly<Record<string, { uid: number; gid: number }>> = {
  'sha256:a5a5302f2443c02f24506248883b9d22f070f58b288f898ac69a547b653e2161': { uid: 998, gid: 998 },
};
export type SymposiumArtifactOwner = { image: string; uid: number; gid: number };
export function symposiumArtifactOwner(image: string): SymposiumArtifactOwner {
  const owner = Object.hasOwn(reviewedOwners, image) ? reviewedOwners[image] : undefined;
  if (!owner)
    throw new Error(
      'Artifact workload image identity is not reviewed; review its UID/GID before preparing volumes',
    );
  return { image, ...owner };
}
export function artifactOwnerContract(owner: SymposiumArtifactOwner): string {
  return JSON.stringify({ image: owner.image, uid: owner.uid, gid: owner.gid });
}
