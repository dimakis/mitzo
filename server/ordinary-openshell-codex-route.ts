import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { SessionRuntimeBindingV2Schema, type AccountBinding } from '@mitzo/protocol';
import { sameOpenShellRouteAuthority } from './openshell-route-authority.js';
import { SUPPORTED_CODEX_CLI_VERSION } from './codex-app-server-client.js';
import type { AccountProfiles } from './account-profiles.js';
import type { ArtifactRuntime } from './codex-conversation-store.js';
import type { OpenShellAccountRoute, OpenShellRuntimeConfig } from './openshell-runtime.js';
import {
  resolveOrdinarySessionRuntime,
  type OrdinarySessionRuntimeCatalog,
} from './ordinary-session-runtime.js';

const unavailable = () => new Error('Ordinary OpenShell Codex route unavailable');

/** Configuration projection only. Reuses the existing runtime configuration;
 * this is neither a registry nor evidence of provider enrollment/readiness.
 * The target identifies the execution namespace and native protocol, not a
 * release. The entry owner separately attests current code, policy and seed.
 */
export function ordinaryOpenShellCodexTarget(input: {
  targetId: string;
  runtimeContractRevision: string;
  config: OpenShellRuntimeConfig;
  openaiApi: 'enabled' | 'disabled';
}) {
  const { config } = input;
  const targetRevision = createHash('sha256')
    .update(
      JSON.stringify([
        'ordinary-openshell-codex-target-v2',
        input.targetId,
        SUPPORTED_CODEX_CLI_VERSION,
        input.openaiApi,
        config.cli,
        config.workspace,
        config.gateway,
        config.gatewayEndpoint,
        config.gatewayInsecure,
        Object.entries(config.cliEnvironment ?? {}).sort(([a], [b]) => a.localeCompare(b)),
        config.workdir,
        config.cliContract,
      ]),
    )
    .digest('hex');
  const target = {
    targetId: input.targetId,
    targetRevision,
    location: 'openshell' as const,
    ownership: 'dedicated-ordinary' as const,
    openaiApi: input.openaiApi,
  };
  SessionRuntimeBindingV2Schema.shape.execution.shape.targetId.parse(input.targetId);
  SessionRuntimeBindingV2Schema.shape.execution.shape.targetRevision.parse(
    input.runtimeContractRevision,
  );
  return target;
}

/** Fail-closed configuration adoption. The owning admission must separately
 * fence provider grant revocation, physical resource ownership, workspace and
 * profile/context delivery before effects. Never reads environment or allocates.
 * retained and expectedRetained come from the existing continuation/lifecycle
 * owners, not request JSON. Mutable model selection is compared separately.
 */
export function assertOrdinaryOpenShellCodexRoute(input: {
  binding: unknown;
  account: AccountBinding;
  profiles: Pick<AccountProfiles, 'validateModelSelection' | 'codexRoutingProfile' | 'apiProfile'>;
  catalog: OrdinarySessionRuntimeCatalog;
  target: ReturnType<typeof ordinaryOpenShellCodexTarget>;
  model: string;
  reasoningEffort?: string | null;
  mode: 'ask' | 'agent' | 'auto';
  retained?: ArtifactRuntime;
  expectedRetained?: ArtifactRuntime;
}): OpenShellAccountRoute {
  try {
    const binding = SessionRuntimeBindingV2Schema.parse(input.binding);
    if (
      binding.execution.location !== 'openshell' ||
      binding.harness.implementation !== 'codex' ||
      binding.execution.targetId !== input.target.targetId ||
      binding.execution.targetRevision !== input.target.targetRevision ||
      !isDeepStrictEqual(binding.account, {
        accountId: input.account.accountId,
        provider: input.account.provider,
        profileRevision: input.account.profileRevision,
      })
    )
      throw unavailable();
    const resolution = resolveOrdinarySessionRuntime(
      {
        account: binding.account,
        harness: 'codex',
        targetId: binding.execution.targetId,
        mode: input.mode,
      },
      input.catalog,
    );
    if (
      resolution.status !== 'compatible' ||
      !isDeepStrictEqual(resolution.binding, binding) ||
      !isDeepStrictEqual(
        input.catalog.targets.find((t) => t.targetId === input.target.targetId),
        input.target,
      )
    )
      throw unavailable();
    input.profiles.validateModelSelection(input.account, input.model, input.reasoningEffort);
    let route: OpenShellAccountRoute;
    if (input.account.provider === 'openai-codex') {
      const profile = input.profiles.codexRoutingProfile(input.account);
      if (
        profile.accountId !== input.account.accountId ||
        profile.nativeAuth ||
        profile.credentialRef ||
        profile.planType.trim().toLowerCase() === 'api' ||
        profile.sandboxProviderType !== 'openai-codex-oauth' ||
        !profile.sandboxProvider ||
        !profile.sandboxProviderId ||
        !profile.sandboxGrantId
      )
        throw unavailable();
      route = {
        kind: 'chatgpt-subscription',
        provider: profile.sandboxProvider,
        providerType: 'openai-codex-oauth',
        providerId: profile.sandboxProviderId,
        grantId: profile.sandboxGrantId,
        model: input.model,
      };
    } else if (input.account.provider === 'openai') {
      const profile = input.profiles.apiProfile({ ...input.account, model: input.model });
      if (!profile.sandboxProvider) throw unavailable();
      route = { kind: 'api', provider: profile.sandboxProvider, model: input.model };
    } else throw unavailable();
    if (Boolean(input.retained) !== Boolean(input.expectedRetained)) throw unavailable();
    if (
      input.retained &&
      input.expectedRetained &&
      (!input.retained.runtime.sandboxId ||
        !input.retained.runtime.sandboxName ||
        !isDeepStrictEqual(input.retained.runtime, input.expectedRetained.runtime) ||
        !sameOpenShellRouteAuthority(input.retained.route, input.expectedRetained.route) ||
        !sameOpenShellRouteAuthority(input.retained.route, route))
    )
      throw unavailable();
    return structuredClone(route);
  } catch {
    throw unavailable();
  }
}

/** Projection into the existing compatibility resolver, not a runtime registry.
 * A caller must keep routes unavailable for dispatch until owning admission and
 * exact continuation authority are installed. OpenShell remains the preference.
 */
export function projectOrdinaryOpenShellCodexCapabilities(input: {
  profiles: Pick<AccountProfiles, 'ordinaryOpenShellCodexInventory'>;
  target: ReturnType<typeof ordinaryOpenShellCodexTarget>;
  deployment: OrdinarySessionRuntimeCatalog['deployment'];
}) {
  const source = input.profiles.ordinaryOpenShellCodexInventory(
    input.target.targetId,
    input.target.openaiApi === 'enabled',
  );
  const catalog: OrdinarySessionRuntimeCatalog = {
    deployment: input.deployment,
    enabledHarnesses: source.length ? ['codex'] : [],
    accounts: source.map(({ account }) => account),
    targets: [input.target],
  };
  const accounts = source.map(({ account, ...metadata }) => ({
    account: {
      accountId: account.accountId,
      provider: account.provider,
      profileRevision: account.profileRevision,
    },
    ...metadata,
  }));
  const routes = accounts.flatMap(({ account }) => {
    const modes = (['agent', 'auto'] as const).filter(
      (mode) =>
        resolveOrdinarySessionRuntime(
          { account, targetId: input.target.targetId, harness: 'codex', mode },
          catalog,
        ).status === 'compatible',
    );
    return modes.length
      ? [{ account, targetId: input.target.targetId, harness: 'codex' as const, modes }]
      : [];
  });
  const inventory = {
    version: 1 as const,
    authority: 'configuration-only' as const,
    defaultLocation: 'openshell' as const,
    accounts,
    targets: [input.target],
    routes,
    capabilityRevision: createHash('sha256')
      .update(
        JSON.stringify([
          'ordinary-openshell-codex-capabilities-v1',
          catalog,
          accounts.map(({ account, models, modelDiscovery }) => [
            account,
            models.map(({ id, reasoningEfforts, defaultReasoningEffort }) => [
              id,
              reasoningEfforts,
              defaultReasoningEffort,
            ]),
            modelDiscovery.source,
            modelDiscovery.stale,
          ]),
        ]),
      )
      .digest('hex'),
    locations: [
      {
        location: 'openshell' as const,
        status: 'unavailable' as const,
        reason: 'openshell_admission_pending' as const,
      },
    ],
  };
  if (
    accounts.length > 64 ||
    accounts.some((account) => account.models.length > 256) ||
    Buffer.byteLength(JSON.stringify(inventory), 'utf8') > 1048576
  )
    throw unavailable();
  return { catalog: structuredClone(catalog), inventory: structuredClone(inventory) };
}
