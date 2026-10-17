import type { EventStore } from './event-store.js';
/** Saved provenance is evidence for a review, never authority to adopt or delete. */
export interface SandboxOwnershipEvidence {
  conversationId: string;
  physicalId: string;
  sandboxName: string;
  workspace: string;
  gateway: string | null;
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
      ((owner.gateway === physical.gateway &&
        (owner.gatewayEndpoint ?? null) === (physical.gatewayEndpoint ?? null)) ||
        (owner.gateway === null &&
          owner.ownerKind === 'symposium' &&
          owner.relation === 'symposium_seat')),
  );
  const blockers = ['lifecycle_missing', 'checkpoint_unverified'];
  if (!owners.length) blockers.push('owner_unresolved');
  if (new Set(owners.map((owner) => owner.conversationId)).size > 1)
    blockers.push('ownership_conflict');
  if (owners.some((owner) => owner.ownerKind === 'symposium')) blockers.push('symposium');
  if (owners.some((owner) => owner.relation.startsWith('migration_'))) blockers.push('migration');
  if (owners.some((owner) => owner.gateway === null)) blockers.push('gateway_scope_unverified');
  if (physical.phase === 'Error') blockers.push('resource_error');
  return {
    physical: { id: physical.id, name: physical.name, state: physical.phase },
    owners,
    blockers,
    canDelete: false as const,
    observedAt: Date.now(),
  };
}

/** Production composition reads both durable registries, independently of visible chat lists. */
export function readSandboxOwnershipReview(
  physical: Parameters<typeof reviewSandboxOwnership>[0],
  conversations: { listSandboxOwnership(): SandboxOwnershipEvidence[] },
  events: Pick<EventStore, 'listRetainedSymposiumSandboxOwners' | 'getSession'>,
) {
  const seats: SandboxOwnershipEvidence[] = events
    .listRetainedSymposiumSandboxOwners(physical.id, physical.name, physical.workspace)
    .map((seat) => ({
      ...seat,
      physicalId: physical.id,
      sandboxName: physical.name,
      workspace: physical.workspace,
      // Historical seat records did not persist gateway scope. Never infer it from current config.
      gateway: null,
      ownerKind: 'symposium',
      relation: 'symposium_seat',
    }));
  const review = reviewSandboxOwnership(physical, [
    ...conversations.listSandboxOwnership(),
    ...seats,
  ]);
  return {
    ...review,
    owners: review.owners.map((owner) => {
      const session = events.getSession(owner.conversationId);
      return {
        ...owner,
        title: session?.summary ?? 'Saved conversation',
        accountLabel: session?.accountBinding?.accountLabel ?? owner.accountId,
      };
    }),
  };
}
