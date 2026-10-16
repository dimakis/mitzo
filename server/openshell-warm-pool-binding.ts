import { createHash } from 'node:crypto';
import type { OpenShellWarmPool } from './openshell-warm-pool.js';
import type { BoundOpenShellRuntimeConfig } from './openshell-runtime.js';
import { warmPoolScope } from './openshell-warm-pool-runtime.js';
let pool: OpenShellWarmPool | null = null;
/** Installed by the host composition, never by a command payload. */
export function setOpenShellWarmPool(value: OpenShellWarmPool | null) {
  pool = value;
}
export function getOpenShellWarmPool() {
  return pool;
}
export function warmPoolConversationName(
  config: BoundOpenShellRuntimeConfig,
  conversationId: string,
) {
  if (!pool) return undefined;
  const record = pool.snapshot().owned.find((x) => x.conversationId === conversationId);
  if (!record) return undefined;
  if (
    record.provider !== config.account.provider ||
    (record.connectionAccountId ?? null) !== (config.connectionAccountId ?? null)
  )
    throw Error('Warm sandbox account binding differs');
  if (record.scope !== warmPoolScope(config) || record.state !== 'claimed')
    throw Error('Warm sandbox claim or runtime identity is unverified');
  return record.name;
}
/** Pool labels are immutable origin evidence. Effective conversation/account
 * ownership comes exclusively from the durable claim, bound to the physical ID
 * and full runtime scope. This does not rewrite gateway labels or confer ownership
 * from a name. Ordinary unpooled label checks remain unchanged. */
export function projectWarmPoolOwnership<
  T extends { id?: string; name: string; workspace?: string; labels?: Record<string, string> },
>(config: BoundOpenShellRuntimeConfig, sandbox: T): T {
  const id = sandbox.labels?.['mitzo.warm_pool'];
  if (!id) return sandbox;
  const record = pool?.snapshot().owned.find((x) => x.id === id);
  if (!record || record.state !== 'claimed')
    throw Error('Warm sandbox has no verified claimed owner');
  if (
    (record.connectionAccountId ?? null) !== (config.connectionAccountId ?? null) ||
    record.provider !== config.account.provider ||
    record.name !== sandbox.name ||
    record.physicalId !== sandbox.id ||
    sandbox.workspace !== config.workspace ||
    record.scope !== warmPoolScope(config) ||
    sandbox.labels?.['mitzo.conversation'] ||
    sandbox.labels?.['mitzo.account_provider']
  )
    throw Error('Warm sandbox physical/account identity differs');
  return {
    ...sandbox,
    labels: {
      ...sandbox.labels,
      'mitzo.conversation': createHash('sha256')
        .update(record.conversationId!)
        .digest('hex')
        .slice(0, 63),
      'mitzo.account_provider': record.provider!,
      ...(record.connectionAccountId
        ? { 'mitzo.connection_account': record.connectionAccountId }
        : {}),
    },
  };
}
export async function claimWarmPoolForCommand(
  config: BoundOpenShellRuntimeConfig,
  conversationId: string,
  signal: AbortSignal,
  seed?: string,
) {
  if (
    !pool ||
    !pool.adapter.available ||
    config.cliContract ||
    config.artifactDriverConfig ||
    config.accountProviderBindings?.length ||
    config.sandboxNameOverride ||
    config.account.kind !== 'api' ||
    warmPoolScope(config) !== pool.adapter.scope
  )
    return null;
  return pool.claim(
    conversationId,
    config.account.provider,
    signal,
    seed,
    config.serviceProviders,
    config.connectionAccountId,
  );
}

/** Saved pool limits also govern compatible cold allocations; retained sandboxes
 * keep the limits with which they were created. */
export function warmPoolCreateResources(config: BoundOpenShellRuntimeConfig) {
  if (
    !pool ||
    !pool.adapter.available ||
    config.cliContract ||
    config.artifactDriverConfig ||
    config.accountProviderBindings?.length ||
    config.sandboxNameOverride ||
    config.account.kind !== 'api' ||
    warmPoolScope(config) !== pool.adapter.scope
  )
    return undefined;
  const { cpu, memoryGiB } = pool.snapshot().settings;
  return { cpu, memoryGiB };
}

/** Assignment cleanup cannot infer account ownership from the neutral origin label.
 * Resolve the durable account only after observing the exact physical resource in
 * the same gateway/workspace. Missing or changed authority blocks partial cleanup. */
export async function warmPoolConnectionAccount(
  sandbox: { name: string; labels: Record<string, string> },
  gateway: string,
  workspace: string,
  signal: AbortSignal,
) {
  const id = sandbox.labels['mitzo.warm_pool'];
  const record = pool?.snapshot().owned.find((x) => x.id === id);
  const authority = pool?.adapter.connectionAuthority;
  if (
    !pool ||
    !record ||
    !record.connectionAccountId ||
    !record.physicalId ||
    record.name !== sandbox.name ||
    record.scope !== pool.adapter.scope ||
    authority?.gateway !== gateway ||
    authority?.workspace !== workspace
  )
    throw Error('Warm sandbox connection account ownership is unverified');
  const physical = await pool.adapter.inspect(record, signal);
  if (
    !physical ||
    physical.id !== record.physicalId ||
    physical.name !== record.name ||
    physical.poolId !== record.id
  )
    throw Error('Warm sandbox connection account physical identity differs');
  return record.connectionAccountId;
}
