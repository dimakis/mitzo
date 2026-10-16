import { createHash } from 'node:crypto';
import { hasWarmPoolRuntimeAuthority, type OpenShellWarmPool } from './openshell-warm-pool.js';
import type { BoundOpenShellRuntimeConfig } from './openshell-runtime.js';
import { warmPoolScope, warmPoolRuntimeAuthority } from './openshell-warm-pool-runtime.js';
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
  if (
    !hasWarmPoolRuntimeAuthority(record, {
      scope: warmPoolScope(config),
      runtimeAuthority: warmPoolRuntimeAuthority(config),
    }) ||
    record.state !== 'claimed'
  )
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
    !hasWarmPoolRuntimeAuthority(record, {
      scope: warmPoolScope(config),
      runtimeAuthority: warmPoolRuntimeAuthority(config),
    }) ||
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
/** Read-only telemetry may project physical usage across account IDs. This is
 * deliberately separate from the account-bound execution ownership check above. */
export function projectWarmPoolInventoryOwnership<
  T extends {
    id?: string;
    name: string;
    workspace?: string;
    labels?: Record<string, string>;
  },
>(config: BoundOpenShellRuntimeConfig, sandbox: T): T {
  const id = sandbox.labels?.['mitzo.warm_pool'];
  if (!id) return sandbox;
  if (sandbox.labels?.['mitzo.conversation'] || sandbox.labels?.['mitzo.account_provider'])
    throw Error('Warm inventory physical ownership labels conflict');
  const record = pool?.snapshot().owned.find((x) => x.id === id);
  if (!record || record.provider !== config.account.provider) return sandbox;
  if (
    !record.conversationId ||
    !record.physicalId ||
    record.name !== sandbox.name ||
    record.physicalId !== sandbox.id ||
    sandbox.workspace !== config.workspace ||
    !hasWarmPoolRuntimeAuthority(record, {
      scope: warmPoolScope(config),
      runtimeAuthority: warmPoolRuntimeAuthority(config),
    })
  )
    throw Error('Warm inventory physical/runtime identity differs');
  return {
    ...sandbox,
    labels: {
      ...sandbox.labels,
      'mitzo.conversation': createHash('sha256')
        .update(record.conversationId)
        .digest('hex')
        .slice(0, 63),
      'mitzo.account_provider': record.provider,
      ...(record.connectionAccountId
        ? { 'mitzo.connection_account': record.connectionAccountId }
        : {}),
    },
  };
}
/** A normal authorized ensure can retry binding the original resource before
 * native initialization. It cannot allocate, transfer or recycle ownership. */
export async function recoverWarmPoolClaim(
  config: BoundOpenShellRuntimeConfig,
  conversationId: string,
  signal: AbortSignal,
  seed: string | undefined,
  expected: { sandboxName: string; sandboxId: string } | undefined,
  beforeRecovery: () => Promise<void>,
) {
  const record = pool?.snapshot().owned.find((x) => x.conversationId === conversationId);
  if (
    !pool ||
    !record ||
    record.state === 'claimed' ||
    (config.sandboxNameOverride && config.sandboxNameOverride !== record.name)
  )
    return;
  if (
    record.state !== 'uncertain' ||
    config.cliContract ||
    config.artifactDriverConfig ||
    config.accountProviderBindings?.length ||
    config.account.kind !== 'api' ||
    record.provider !== config.account.provider ||
    (record.connectionAccountId ?? null) !== (config.connectionAccountId ?? null) ||
    record.scope !== warmPoolScope(config) ||
    record.scope !== pool.adapter.scope ||
    !hasWarmPoolRuntimeAuthority(record, {
      scope: warmPoolScope(config),
      runtimeAuthority: warmPoolRuntimeAuthority(config),
    }) ||
    (expected && (expected.sandboxName !== record.name || expected.sandboxId !== record.physicalId))
  )
    throw Error('Warm claim recovery account/physical binding is unverified');
  signal.throwIfAborted();
  await beforeRecovery();
  await pool.claim(
    conversationId,
    config.account.provider,
    signal,
    seed,
    config.serviceProviders,
    config.connectionAccountId,
  );
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
    !hasWarmPoolRuntimeAuthority(record, pool.adapter) ||
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
