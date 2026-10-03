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
