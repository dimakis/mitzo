/** Saved provenance is evidence for a review, never authority to adopt or delete. */
export interface SandboxOwnershipEvidence {
  conversationId: string;
  physicalId: string;
  sandboxName: string;
  workspace: string;
  gateway: string;
  gatewayEndpoint?: string | null;
  accountId: string;
  ownerKind: string | null;
  relation: string;
}
export function reviewSandboxOwnership(
  physical: {
    id: string;
    name: string;
    phase: string;
    workspace: string;
    gateway: string;
    gatewayEndpoint?: string | null;
  },
  evidence: SandboxOwnershipEvidence[],
) {
  const owners = evidence.filter(
    (owner) =>
      owner.physicalId === physical.id &&
      owner.sandboxName === physical.name &&
      owner.workspace === physical.workspace &&
      owner.gateway === physical.gateway &&
      (owner.gatewayEndpoint ?? null) === (physical.gatewayEndpoint ?? null),
  );
  const blockers = ['lifecycle_missing', 'checkpoint_unverified'];
  if (!owners.length) blockers.push('owner_unresolved');
  if (new Set(owners.map((owner) => owner.conversationId)).size > 1)
    blockers.push('ownership_conflict');
  if (owners.some((owner) => owner.ownerKind === 'symposium')) blockers.push('symposium');
  if (owners.some((owner) => owner.relation.startsWith('migration_'))) blockers.push('migration');
  if (physical.phase === 'Error') blockers.push('resource_error');
  return {
    physical: { id: physical.id, name: physical.name, state: physical.phase },
    owners,
    blockers,
    canDelete: false as const,
    observedAt: Date.now(),
  };
}
