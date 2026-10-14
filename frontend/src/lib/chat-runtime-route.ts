import type { ExplicitLocalInventory } from './explicit-local-chat';
import type { ChatRuntimeSelection } from './chat-runtime-selection';
const sameAccount = (
  a: NonNullable<ChatRuntimeSelection['accountReference']>,
  b: NonNullable<ChatRuntimeSelection['accountReference']>,
) =>
  a.accountId === b.accountId &&
  a.provider === b.provider &&
  a.profileRevision === b.profileRevision;
/** Native target identity is server-owned; the picker chooses only environment. */
export function runtimeRoutes(
  intent: ChatRuntimeSelection,
  inventory: ExplicitLocalInventory | null,
) {
  if (!inventory || !intent.account) return [];
  return inventory.routes.filter((route) => {
    const targets = inventory.targets.filter(
      (target) =>
        target.targetId === route.targetId &&
        target.harness === route.harness &&
        (!route.location || target.location === route.location),
    );
    return (
      route.account.accountId === intent.account!.accountId &&
      (!intent.accountReference || sameAccount(route.account, intent.accountReference)) &&
      inventory.accounts.some((entry) => sameAccount(entry.account, route.account)) &&
      targets.length === 1 &&
      targets[0].location === intent.execution.location
    );
  });
}
export function selectedRuntimeRoute(
  intent: ChatRuntimeSelection,
  inventory: ExplicitLocalInventory | null,
) {
  const routes = runtimeRoutes(intent, inventory).filter(
    (route) => route.targetId === intent.execution.targetId,
  );
  return routes.length === 1 ? routes[0] : undefined;
}
export function resolveRuntimeTarget(
  intent: ChatRuntimeSelection,
  inventory: ExplicitLocalInventory | null,
) {
  if (inventory && !intent.account) {
    const targets = inventory.targets.filter(
      (target) =>
        target.location === intent.execution.location &&
        inventory.routes.some(
          (route) =>
            route.targetId === target.targetId &&
            route.harness === target.harness &&
            (!route.location || route.location === target.location) &&
            inventory.targets.filter(
              (candidate) =>
                candidate.targetId === route.targetId &&
                candidate.harness === route.harness &&
                (!route.location || candidate.location === route.location),
            ).length === 1,
        ),
    );
    return targets.length === 1 ? targets[0].targetId : null;
  }
  const routes = runtimeRoutes(intent, inventory);
  return routes.length === 1 ? routes[0].targetId : null;
}
/** Each account catalog is scoped to its one route in this environment; absent or
 * ambiguous routes expose no borrowed models. Account intent stays in the draft. */
export function runtimeModelAccounts(
  intent: ChatRuntimeSelection,
  inventory: ExplicitLocalInventory | null,
) {
  return (inventory?.accounts ?? []).map((account) => {
    const candidate = {
      ...intent,
      account: { accountId: account.account.accountId, model: '', reasoningEffort: null },
      accountReference: account.account,
      execution: { ...intent.execution, targetId: null },
    };
    const routes = runtimeRoutes(candidate, inventory);
    const route =
      account.account.accountId === intent.account?.accountId
        ? selectedRuntimeRoute(intent, inventory)
        : routes.length === 1
          ? routes[0]
          : undefined;
    const profileEligible =
      !intent.agentProfile ||
      !route?.agentProfiles ||
      route.agentProfiles.some(
        (profile) =>
          profile.profileId === intent.agentProfile!.profileId &&
          profile.revision === intent.agentProfile!.revision &&
          profile.kind === intent.agentProfile!.kind,
      );
    return {
      ...account,
      id: account.account.accountId,
      models: route && profileEligible ? (route.models ?? account.models) : [],
      modelDiscovery: route
        ? (route.modelDiscovery ?? account.modelDiscovery)
        : account.modelDiscovery,
    };
  });
}
