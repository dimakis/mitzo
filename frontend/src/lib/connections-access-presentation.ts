import type { AccessResource, ConnectionsAccessInventory } from '../types/connections-access';

/** Group display facets only; preserve both canonical resources and source states. */
export function connectionsAccessCards(inventory: ConnectionsAccessInventory): Array<{
  resource: AccessResource;
  catalog?: AccessResource;
}> {
  const paired = new Map<string, AccessResource>();
  const catalogs = new Set<string>();
  const available = (id: ConnectionsAccessInventory['sources'][number]['id']) =>
    inventory.sources.some((source) => source.id === id && source.state === 'available');
  if (available('personal') && available('symposiumAccounts')) {
    for (const personal of inventory.resources) {
      if (
        personal.kind !== 'personal-connection' ||
        personal.owner !== 'symposium-personal' ||
        personal.status !== 'connected'
      )
        continue;
      const matches = inventory.resources.filter(
        (catalog) =>
          catalog.kind === 'ai-account' &&
          catalog.owner === 'symposium-account-profiles' &&
          catalog.provider === 'openai-codex' &&
          catalog.personalConnection?.state === 'current' &&
          catalog.personalConnection.resourceId === personal.id &&
          catalog.personalConnection.revision === personal.revision,
      );
      if (
        matches.length !== 1 ||
        inventory.resources.filter((row) => row.id === personal.id).length !== 1 ||
        inventory.resources.filter((row) => row.id === matches[0].id).length !== 1
      )
        continue;
      paired.set(personal.id, matches[0]);
      catalogs.add(matches[0].id);
    }
  }
  return inventory.resources
    .filter((resource) => !catalogs.has(resource.id))
    .map((resource) => ({ resource, catalog: paired.get(resource.id) }));
}

/** Authentication evidence is independent of generic access verification. */
export function accountSignInLabel(resource: AccessResource): string {
  const signIn = resource.signIn;
  if (!signIn) return 'Not checked';
  switch (signIn.status) {
    case 'verified':
      if (signIn.source === 'openshell-provider-grant') return 'Connected';
      if (signIn.source === 'host-account-read' || signIn.source === 'isolated-native-auth')
        return 'Signed in';
      return 'Not checked';
    case 'stale':
      return 'Check is stale';
    case 'failed':
      return 'Check failed';
    case 'unsupported':
      return 'Unsupported';
    default:
      return 'Not checked';
  }
}

export function accountSignInIdentity(resource: AccessResource) {
  const signIn = resource.signIn;
  const observed =
    signIn?.status === 'verified' &&
    (signIn.source === 'host-account-read' || signIn.source === 'isolated-native-auth')
      ? signIn.observedIdentity
      : null;
  return {
    observed,
    configuredEmail: signIn?.configuredIdentity.email ?? resource.accountIdentity,
    configuredPlan: signIn?.configuredIdentity.planType ?? null,
  };
}

export function hasAccountSignIn(resource: AccessResource): boolean {
  return (
    Boolean(resource.signIn) ||
    (resource.kind === 'ai-account' && resource.provider === 'openai-codex')
  );
}

/** Retained evidence expires even while the inventory view stays open. */
export function expireAccountSignIns(
  inventory: ConnectionsAccessInventory,
): ConnectionsAccessInventory {
  const now = Date.now();
  let changed = false;
  const resources = inventory.resources.map((resource): AccessResource => {
    const signIn = resource.signIn;
    if (signIn?.status !== 'verified') return resource;
    if (
      signIn.checkedAt !== null &&
      now - signIn.checkedAt < 5 * 60_000 &&
      (signIn.expiresAt == null || signIn.expiresAt <= 0 || signIn.expiresAt > now)
    )
      return resource;
    changed = true;
    return {
      ...resource,
      signIn: {
        ...signIn,
        status: 'stale',
        explanation: 'The sign-in check is out of date. Refresh access to check again.',
      },
    };
  });
  return changed ? { ...inventory, resources } : inventory;
}
