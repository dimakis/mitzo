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
  if (
    signIn.expiresAt != null &&
    signIn.expiresAt > 0 &&
    signIn.expiresAt <= Date.now() &&
    (signIn.status === 'verified' || signIn.status === 'stale')
  )
    return 'Connection check expired';
  switch (signIn.status) {
    case 'verified':
      if (signIn.source === 'openshell-provider-grant') return 'Connection valid';
      if (signIn.source === 'host-account-read' || signIn.source === 'isolated-native-auth')
        return 'Signed in';
      return 'Not checked';
    case 'stale':
      return 'Last sign-in check passed';
    case 'failed':
      return "Couldn't check sign-in";
    case 'unsupported':
      return 'Not checked';
    default:
      return 'Not checked';
  }
}

/** Reserved placeholder addresses are configuration internals, never an identity. */
function displayIdentity(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text && !/@[^@]*\.invalid$/i.test(text) ? text : null;
}

export function connectionTitle(resource: AccessResource, resources: AccessResource[]): string {
  if (resource.kind !== 'legacy-provider' || !resource.details.serviceName) return resource.label;
  const other = resources.some(
    (row) => row.id !== resource.id && row.details.serviceName === resource.details.serviceName,
  );
  return `${resource.details.serviceName}${other ? ' · additional connection' : ''}`;
}

export function connectionStatus(resource: AccessResource): string {
  if (
    ['reauth_required', 'needs_sign_in'].includes(resource.status) ||
    (resource.status === 'needs_attention' &&
      ['JIRA_AUTH_REJECTED', 'GITHUB_AUTH_REJECTED', 'CUSTOM_REST_AUTH_REJECTED'].includes(
        resource.errorCode ?? '',
      ))
  )
    return 'Reconnect required';
  if (resource.section === 'accounts' && ['configured', 'connected'].includes(resource.status))
    return 'Set up';
  if (resource.kind === 'legacy-provider') return 'Set up';
  if (resource.status === 'active' || resource.status === 'ready') return 'Connection enabled';
  const text = resource.status.replace(/[_-]/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function serviceIdentity(resource: AccessResource): string | null {
  const identity = displayIdentity(resource.accountIdentity);
  const configured = displayIdentity(resource.details.configuredIdentity);
  const opaque =
    identity &&
    /^(?:\d+:)?[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(identity);
  if (identity && !opaque) return identity;
  return configured ? `Configured account: ${configured}` : null;
}

export function serviceScope(resource: AccessResource): string[] {
  const labels: Record<string, string> = {
    allowedRepositories: 'PR repositories',
    allowedBaseBranches: 'PR base branches',
    repositories: 'Repositories',
    endpoint: 'Site',
    allowedMethods: 'Methods',
    allowedPaths: 'Paths',
  };
  return Object.entries(resource.details.scope ?? {})
    .filter(([key]) => key !== 'email')
    .map(
      ([key, value]) => `${labels[key] ?? key}: ${Array.isArray(value) ? value.join(', ') : value}`,
    );
}

export function accountSignInIdentity(resource: AccessResource) {
  const signIn = resource.signIn;
  const observed =
    signIn?.status === 'verified' &&
    (signIn.source === 'host-account-read' || signIn.source === 'isolated-native-auth')
      ? signIn.observedIdentity && {
          ...signIn.observedIdentity,
          email: displayIdentity(signIn.observedIdentity.email) ?? '',
        }
      : null;
  return {
    observed,
    configuredEmail: displayIdentity(signIn?.configuredIdentity.email ?? resource.accountIdentity),
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
        explanation: 'The last sign-in check passed at the recorded time. Refresh to check again.',
      },
    };
  });
  return changed ? { ...inventory, resources } : inventory;
}

/** Only account rows from an explicitly unavailable owning source can be cached. */
export function accountResourceSource(
  resource: AccessResource,
): 'accounts' | 'symposiumAccounts' | null {
  if (resource.kind !== 'ai-account') return null;
  if (resource.owner === 'account-profiles') return 'accounts';
  if (resource.owner === 'symposium-account-profiles') return 'symposiumAccounts';
  return null;
}

export function retainUnavailableAccounts(
  previous: ConnectionsAccessInventory | null,
  next: ConnectionsAccessInventory,
): ConnectionsAccessInventory {
  if (!previous) return next;
  const failed = new Set(
    next.sources.filter((source) => source.state === 'unavailable').map((source) => source.id),
  );
  const ids = new Set(next.resources.map((resource) => resource.id));
  const retained: AccessResource[] = [];
  for (const resource of previous.resources) {
    const source = accountResourceSource(resource);
    if (!source || !failed.has(source) || ids.has(resource.id)) continue;
    ids.add(resource.id);
    retained.push({
      ...resource,
      signIn:
        resource.signIn &&
        (resource.signIn.status === 'verified' || resource.signIn.status === 'stale')
          ? {
              ...resource.signIn,
              status: 'stale',
              explanation: 'Account source is unavailable. Showing an older sign-in check.',
            }
          : resource.signIn,
      verification: {
        ...resource.verification,
        state: resource.verification.state === 'verified' ? 'stale' : resource.verification.state,
      },
      personalConnection: resource.personalConnection
        ? { ...resource.personalConnection, state: 'unavailable' }
        : undefined,
    });
  }
  return retained.length ? { ...next, resources: [...next.resources, ...retained] } : next;
}
