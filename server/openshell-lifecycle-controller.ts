import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountBinding } from '@mitzo/protocol';
import { codexPrivateDirectory } from './codex-private-path.js';
import {
  OpenShellCheckpointTransport,
  type CheckpointIdentity,
} from './openshell-checkpoint-transport.js';
import {
  OpenShellLifecycleStore,
  sharedOpenShellLifecycleCoordinator,
  openShellLifecycleEnabled,
  openShellLifecyclePolicy,
  type OpenShellLifecycleAuditEntry,
  type OpenShellLifecycleIdentity,
  type OpenShellLifecycleRecord,
} from './openshell-lifecycle.js';
import { createOpenShellLifecycleProductionAdapter } from './openshell-lifecycle-production.js';
import { OpenShellLifecycleService } from './openshell-lifecycle-service.js';
import { createLogger } from './logger.js';
import {
  OpenShellRuntimeManager,
  type OpenShellAccountRoute,
  type OpenShellRuntime,
  type OpenShellRuntimeConfig,
} from './openshell-runtime.js';

interface ProtectionSources {
  registry: Parameters<typeof createOpenShellLifecycleProductionAdapter>[0]['registry'];
  eventStore: Parameters<typeof createOpenShellLifecycleProductionAdapter>[0]['eventStore'];
  taskStore: Parameters<typeof createOpenShellLifecycleProductionAdapter>[0]['taskStore'];
  queue: Parameters<typeof createOpenShellLifecycleProductionAdapter>[0]['queue'];
  /** Current account-profile sandbox providers, including ones without retained records. */
  accountProviders?: () => Iterable<string>;
  onOutcome?: (action: 'stopped' | 'deleted') => void;
}

let configured:
  | {
      config: OpenShellRuntimeConfig;
      policyDigest: string;
      sources: ProtectionSources;
      store: OpenShellLifecycleStore;
      service: OpenShellLifecycleService;
    }
  | undefined;
const log = createLogger('openshell-lifecycle');

function sanitizeLifecycleError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(?:\/[^\s:]+)+/g, '<path>')
    .replace(/https?:\/\/[^\s]+/g, '<endpoint>')
    .slice(0, 180);
}

export function openShellLifecycleCapability(record: OpenShellLifecycleRecord) {
  const route = record.identity?.route;
  // New providers must explicitly supply an adapter; inventory alone never
  // implies a checkpoint or lifecycle action is safe.
  const supported =
    (record.identity?.provider === 'openai' || record.identity?.provider === 'openai-codex') &&
    (route?.kind === 'api' ||
      (route?.kind === 'chatgpt-subscription' && route.providerType === 'openai-codex-oauth'));
  return {
    runtime: Boolean(route),
    checkpoint: supported ? 'supported' : 'unsupported',
    lifecycleActions: supported ? 'supported' : 'unsupported',
  } as const;
}

/** Keeps arbitrary protocol conversation IDs from influencing local paths. */
export function checkpointDirectoryForConversation(
  privateDirectory: string,
  conversationId: string,
  generation: number,
) {
  const key = createHash('sha256').update(conversationId).digest('hex');
  return join(privateDirectory, 'openshell-checkpoints', key, String(generation));
}

/** Read-only, provider-scoped physical sandbox inventory for telemetry. */
export async function openShellLifecyclePhaseCounts(signal: AbortSignal) {
  if (!configured) throw new Error('OpenShell lifecycle controller is unavailable');
  const seen = new Set<string>();
  const phaseCounts: Record<string, number> = {};
  const providerErrors: Record<string, string> = {};
  const providers = new Set(configured.store.list().map((record) => record.accountProvider));
  try {
    for (const provider of configured.sources.accountProviders?.() ?? []) providers.add(provider);
  } catch (error) {
    providerErrors.configured = error instanceof Error ? error.message : String(error);
  }
  for (const provider of providers) {
    try {
      signal.throwIfAborted();
      for (const sandbox of await managerForProvider(provider).inventory(signal)) {
        const key = sandbox.id ?? sandbox.name;
        if (seen.has(key)) continue;
        seen.add(key);
        phaseCounts[sandbox.phase] = (phaseCounts[sandbox.phase] ?? 0) + 1;
      }
    } catch (error) {
      if (signal.aborted) throw error;
      providerErrors[provider] = error instanceof Error ? error.message : String(error);
    }
  }
  return { phaseCounts, providerErrors };
}

function managerForProvider(provider: string) {
  if (!configured) throw new Error('OpenShell lifecycle controller is unavailable');
  // Inventory authenticates through the gateway and filters only on the provider label.
  // It does not invoke a model, so an API route safely inventories either configured route kind.
  return new OpenShellRuntimeManager({
    ...configured.config,
    account: { kind: 'api', provider, model: 'lifecycle-telemetry' },
  });
}

/** Returns physical inventory without ever treating an unreachable provider as
 * an empty list. Each route is queried independently because credentials are
 * provider-scoped. */
export async function openShellLifecycleInventory(signal: AbortSignal) {
  if (!configured)
    return {
      available: false,
      partial: false,
      collectedAt: Date.now(),
      sandboxes: [],
      scopes: [{ status: 'unavailable', error: 'OpenShell lifecycle controller is unavailable' }],
    };
  const records = configured.store.list();
  const byPhysicalId = new Map(
    records
      .filter((record) => record.physicalSandboxId)
      .map((record) => [record.physicalSandboxId!, record]),
  );
  const groups = new Map<string, OpenShellLifecycleRecord>();
  const seen = new Set<string>();
  const sandboxes: Array<ReturnType<typeof lifecycleInventoryRow>> = [];
  const scopes: Array<Record<string, string>> = [];
  for (const record of records) {
    if (!record.identity) {
      scopes.push({
        provider: record.accountProvider ?? 'unknown',
        workspace: record.workspace,
        status: 'unavailable',
        error: 'OpenShell lifecycle identity is unavailable',
      });
      sandboxes.push(lifecycleInventoryRow(record, undefined, 'unavailable'));
      seen.add(record.physicalSandboxId ?? record.sandboxName);
    } else if (!groups.has(JSON.stringify(record.identity.route))) {
      groups.set(JSON.stringify(record.identity.route), record);
    }
  }
  for (const routeRecord of groups.values()) {
    const routeKey = JSON.stringify(routeRecord.identity!.route);
    try {
      const physical = await managerFor(routeRecord).inventory(signal);
      scopes.push({
        provider: routeRecord.identity!.route.provider,
        workspace: routeRecord.workspace,
        status: 'available',
      });
      for (const sandbox of physical) {
        const key = sandbox.id ?? `${routeRecord.workspace}:${sandbox.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const record = sandbox.id
          ? byPhysicalId.get(sandbox.id)
          : records.find(
              (item) =>
                item.workspace === routeRecord.workspace && item.sandboxName === sandbox.name,
            );
        sandboxes.push(lifecycleInventoryRow(record, sandbox, record ? 'verified' : 'orphaned'));
      }
    } catch (error) {
      scopes.push({
        provider: routeRecord.identity!.route.provider,
        workspace: routeRecord.workspace,
        status: 'unavailable',
        error: sanitizeLifecycleError(error),
      });
      for (const record of records.filter(
        (item) => item.identity && JSON.stringify(item.identity.route) === routeKey,
      )) {
        const key = record.physicalSandboxId ?? record.sandboxName;
        if (!seen.has(key)) {
          seen.add(key);
          sandboxes.push(lifecycleInventoryRow(record, undefined, 'unavailable'));
        }
      }
    }
  }
  for (const record of records) {
    const key = record.physicalSandboxId ?? record.sandboxName;
    if (!seen.has(key)) sandboxes.push(lifecycleInventoryRow(record, undefined, 'missing'));
  }
  return {
    available: scopes.some((scope) => scope.status === 'available'),
    partial: scopes.some((scope) => scope.status === 'unavailable'),
    collectedAt: Date.now(),
    sandboxes,
    scopes,
  };
}

function lifecycleInventoryRow(
  record: OpenShellLifecycleRecord | undefined,
  sandbox: { id?: string; name: string; phase: string; workspace?: string } | undefined,
  status: 'verified' | 'orphaned' | 'unavailable' | 'missing',
) {
  const now = Date.now();
  return {
    status,
    name: sandbox?.name ?? record?.sandboxName ?? 'unknown',
    physicalId: sandbox?.id ?? record?.physicalSandboxId ?? null,
    provider: record?.identity?.route.provider ?? record?.accountProvider ?? 'unknown',
    conversationId: record?.conversationId ?? null,
    workspace: sandbox?.workspace ?? record?.workspace ?? null,
    runtimePhase: sandbox?.phase ?? null,
    lifecyclePhase: record?.phase ?? null,
    generation: record?.generation ?? null,
    activityAgeMs: record?.lastActivityAt ? Math.max(0, now - record.lastActivityAt) : null,
    idleAgeMs: record?.idleSince ? Math.max(0, now - record.idleSince) : null,
    checkpoint: record?.checkpoint
      ? { status: 'present', digest: record.checkpoint.digest, version: record.checkpoint.version }
      : { status: 'absent' },
    retentionConsent: record?.retentionConsent ?? false,
    preservationBlockers:
      status === 'unavailable' || status === 'missing' ? ['inventory_unavailable'] : [],
    lastFailure: record?.failure ? sanitizeLifecycleError(record.failure) : null,
    capabilities: record
      ? openShellLifecycleCapability(record)
      : { runtime: true, checkpoint: 'unsupported', lifecycleActions: 'unsupported' },
  };
}

export function recordOpenShellLifecycleAudit(entry: Omit<OpenShellLifecycleAuditEntry, 'id'>) {
  configured?.store.appendAudit(entry);
}
export function openShellLifecycleAudit(limit?: number) {
  return configured?.store.listAudit(limit) ?? [];
}
export function openShellLifecycleRecord(conversationId: string) {
  return configured?.store.get(conversationId) ?? null;
}

function route(identity: OpenShellLifecycleIdentity): OpenShellAccountRoute {
  if (identity.route.kind === 'api') return identity.route;
  if (identity.route.providerType !== 'openai-codex-oauth')
    throw new Error('OpenShell lifecycle subscription route is unsupported');
  return {
    kind: 'chatgpt-subscription',
    provider: identity.route.provider,
    providerType: 'openai-codex-oauth',
    providerId: identity.route.providerId,
    grantId: identity.route.grantId,
    model: identity.route.model,
  };
}

function managerFor(record: OpenShellLifecycleRecord) {
  if (!configured) throw new Error('OpenShell lifecycle controller is unavailable');
  if (!record.identity) throw new Error('OpenShell lifecycle identity is unavailable');
  const config = configured.config;
  if (
    record.workspace !== config.workspace ||
    record.gateway !== config.gateway ||
    record.gatewayEndpoint !== (config.gatewayEndpoint ?? null) ||
    record.identity.image !== config.image ||
    record.identity.policyDigest !== configured.policyDigest
  )
    throw new Error('OpenShell lifecycle runtime configuration changed');
  return new OpenShellRuntimeManager({ ...config, account: route(record.identity) });
}

function runtimeFor(record: OpenShellLifecycleRecord): OpenShellRuntime {
  if (!configured) throw new Error('OpenShell lifecycle controller is unavailable');
  const config = configured.config;
  return {
    sandboxName: record.sandboxName,
    sandboxId: record.physicalSandboxId ?? '',
    workdir: config.workdir,
    appServerCommand:
      record.identity?.route.kind === 'chatgpt-subscription'
        ? '/sandbox/run-mitzo-subscription-app-server'
        : '/sandbox/run-mitzo-app-server',
    cli: config.cli,
    gateway: record.gateway,
    workspace: record.workspace,
    ...(record.gatewayEndpoint ? { gatewayEndpoint: record.gatewayEndpoint } : {}),
    gatewayInsecure: config.gatewayInsecure,
  };
}

/** Archive verification must use its immutable capture origin, never a later
 * replacement sandbox that happens to own the same conversation. */
function checkpointIdentity(
  record: OpenShellLifecycleRecord,
  origin: { sandboxId: string; resourceVersion: string },
): CheckpointIdentity {
  const identity = record.identity;
  if (!identity || !origin.sandboxId || !origin.resourceVersion)
    throw new Error('OpenShell lifecycle identity is unavailable');
  return {
    conversation: record.conversationId,
    thread: identity.threadId,
    binding: JSON.stringify([
      identity.accountId,
      identity.provider,
      identity.model,
      identity.profileRevision,
    ]),
    image: identity.image,
    policy: identity.policyDigest,
    sandboxId: origin.sandboxId,
    resourceVersion: origin.resourceVersion,
    accountProvider: record.accountProvider,
    accountId: identity.accountId,
    provider: identity.provider,
    model: identity.model,
    profileRevision: identity.profileRevision,
    runtimeScope: identity.runtimeScope,
    routeKind: identity.route.kind,
    routeProvider: identity.route.provider,
    ...(identity.route.kind === 'chatgpt-subscription'
      ? {
          routeProviderType: identity.route.providerType,
          routeProviderId: identity.route.providerId,
          routeGrantId: identity.route.grantId,
        }
      : {}),
  };
}

/** Initialize the single production lifecycle service after its authoritative
 * stores are available. This function is intentionally inert when OpenShell is
 * disabled, so importing the server never creates a sandbox or checkpoint. */
export function initializeOpenShellLifecycle(
  config: OpenShellRuntimeConfig | undefined,
  sources: ProtectionSources,
) {
  // The OpenShell runtime guard must precede all lifecycle policy parsing so a
  // disabled deployment ignores stale lifecycle-only configuration entirely.
  if (!config) return undefined;
  if (!openShellLifecycleEnabled(process.env)) return undefined;
  const policy = openShellLifecyclePolicy(process.env);
  // Lifecycle is explicitly opt-in. Do not make an otherwise usable
  // OpenShell runtime depend on the lifecycle checkpoint policy until it is
  // enabled, because only lifecycle needs to hash that file.
  const directory = codexPrivateDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const store = new OpenShellLifecycleStore(join(directory, 'openshell-lifecycle.db'));
  store.reconcileInterrupted();
  configured = {
    config,
    sources,
    store,
    policyDigest: createHash('sha256').update(readFileSync(config.policy)).digest('hex'),
    service: undefined as unknown as OpenShellLifecycleService,
  };
  const adapter = createOpenShellLifecycleProductionAdapter({
    ...sources,
    lifecycleSupported: (record) =>
      openShellLifecycleCapability(record).lifecycleActions === 'supported',
    inspect: async (record, signal) => {
      if (!record.physicalSandboxId) return undefined;
      return managerFor(record).inspect(record.conversationId, record.physicalSandboxId, signal);
    },
    stop: (record, signal, activityUnchanged) => {
      if (!record.physicalSandboxId)
        return Promise.reject(new Error('OpenShell sandbox identity missing'));
      return managerFor(record).stop(
        record.conversationId,
        record.physicalSandboxId,
        signal,
        activityUnchanged,
      );
    },
    delete: (record, signal, stateUnchanged) => {
      if (!record.physicalSandboxId)
        return Promise.reject(new Error('OpenShell sandbox identity missing'));
      return managerFor(record).delete(
        record.conversationId,
        record.physicalSandboxId,
        signal,
        stateUnchanged,
      );
    },
    checkpoint: async (record, sandbox, signal) => {
      if (!sandbox.resourceVersion)
        throw new Error('OpenShell sandbox resource version is unavailable');
      const transport = new OpenShellCheckpointTransport(runtimeFor(record));
      const result = await transport.capture(
        checkpointDirectoryForConversation(directory, record.conversationId, record.generation),
        checkpointIdentity(record, {
          sandboxId: sandbox.id,
          resourceVersion: sandbox.resourceVersion,
        }),
        signal,
      );
      return {
        path: result.path,
        digest: result.digest,
        version: result.version,
        sandboxId: result.sandboxId,
        sourceResourceVersion: result.resourceVersion,
      };
    },
    verifyCheckpoint: async (record, sandbox, signal) => {
      if (!record.checkpoint) return false;
      const version = record.checkpoint.sourceResourceVersion;
      if (!version || !record.checkpoint.sandboxId || sandbox.id !== record.physicalSandboxId)
        return false;
      const manifest = await new OpenShellCheckpointTransport(runtimeFor(record)).verify(
        record.checkpoint.path,
        checkpointIdentity(record, {
          sandboxId: record.checkpoint.sandboxId,
          resourceVersion: version,
        }),
        signal,
      );
      return (
        manifest.digest === record.checkpoint.digest &&
        manifest.sandboxId === record.checkpoint.sandboxId
      );
    },
    consent: (record) => !!record.retentionConsent,
    onOutcome: (action) => sources.onOutcome?.(action),
    onReconcileError: (record, error) => {
      log.warn('OpenShell lifecycle record reconciliation failed', {
        conversationId: record.conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
  const service = new OpenShellLifecycleService(store, policy, adapter);
  configured.service = service;
  return { service, store, policy };
}

/** Persist physical ownership before downstream app-server setup can fail.
 * Without a provider thread this row is intentionally non-actionable; a later
 * successful registration fills in the complete resumable identity. */
export function registerOpenShellLifecycleProvisional(
  conversationId: string,
  runtime: OpenShellRuntime,
  account: OpenShellAccountRoute,
  ownerClientId?: string,
) {
  if (!configured || !runtime.sandboxId || configured.store.get(conversationId)) return;
  const now = Date.now();
  configured.store.upsert({
    conversationId,
    workspace: configured.config.workspace,
    gateway: configured.config.gateway,
    gatewayEndpoint: configured.config.gatewayEndpoint ?? null,
    sandboxName: runtime.sandboxName,
    physicalSandboxId: runtime.sandboxId,
    accountProvider: account.provider,
    ownerClientId: ownerClientId ?? null,
    phase: 'retained',
    generation: 1,
    lastActivityAt: now,
    idleSince: null,
    stoppedAt: null,
    checkpoint: null,
    retentionConsent: false,
    identity: null,
  });
}

export function registerOpenShellLifecycle(
  conversationId: string,
  runtime: OpenShellRuntime,
  binding: AccountBinding,
  account: OpenShellAccountRoute,
  threadId: string,
  ownerClientId?: string,
) {
  if (!configured) return;
  if (!runtime.sandboxId) return;
  const existing = configured.store.get(conversationId);
  if (existing?.phase === 'failed')
    throw new Error('OpenShell lifecycle recovery must be verified before registration');
  const now = Date.now();
  configured.store.upsert({
    conversationId,
    workspace: configured!.config.workspace,
    gateway: configured!.config.gateway,
    gatewayEndpoint: configured!.config.gatewayEndpoint ?? null,
    sandboxName: runtime.sandboxName,
    physicalSandboxId: runtime.sandboxId,
    accountProvider: account.provider,
    ownerClientId: ownerClientId ?? existing?.ownerClientId ?? null,
    phase: 'retained',
    generation: (existing?.generation ?? 0) + 1,
    lastActivityAt: now,
    idleSince: null,
    stoppedAt: null,
    checkpoint: existing?.checkpoint ?? null,
    retentionConsent: existing?.retentionConsent ?? false,
    identity: {
      threadId,
      accountId: binding.accountId,
      provider: binding.provider,
      model: binding.model,
      profileRevision: binding.profileRevision,
      image: configured!.config.image,
      policyDigest: configured!.policyDigest,
      runtimeScope: configured!.config.workspace,
      route: account,
    },
  });
}

/** A deleted/replaced sandbox may only be brought back from its verified
 * archive. This runs after `ensure` creates the sandbox but before the Codex
 * app-server is launched, so an existing provider thread is never resumed in
 * a blank workspace. */
export async function restoreOpenShellLifecycleIfNeeded(
  conversationId: string,
  runtime: OpenShellRuntime,
  signal: AbortSignal,
  binding?: AccountBinding,
  account?: OpenShellAccountRoute,
  requireExistingRecord = false,
) {
  if (!configured) return;
  const record = configured.store.get(conversationId);
  if (!record) {
    if (requireExistingRecord && runtime.created)
      throw new Error('OpenShell existing conversation has no verified recovery record');
    return;
  }
  // A new sandbox is registered before app-server initialization supplies its
  // provider thread. It is current but intentionally non-actionable, so it
  // cannot be mistaken for a recovery candidate.
  if (
    !record.identity &&
    record.phase === 'retained' &&
    record.physicalSandboxId === runtime.sandboxId &&
    !record.checkpoint
  )
    return;
  if (
    !record.identity ||
    (binding &&
      (record.identity.accountId !== binding.accountId ||
        record.identity.provider !== binding.provider ||
        record.identity.model !== binding.model ||
        record.identity.profileRevision !== binding.profileRevision)) ||
    (account && JSON.stringify(record.identity.route) !== JSON.stringify(account))
  )
    throw new Error('OpenShell lifecycle account binding changed');
  // Validates current runtime image, policy content, gateway, and provider route.
  const manager = managerFor(record);
  const replaced = record.physicalSandboxId !== runtime.sandboxId;
  if (record.phase === 'failed' && !replaced) {
    if (
      !runtime.sandboxId ||
      !record.checkpoint ||
      !record.checkpoint.sandboxId ||
      !record.checkpoint.sourceResourceVersion
    )
      throw new Error('OpenShell failed lifecycle recovery requires a verified checkpoint');
    const sandbox = await manager.inspect(conversationId, runtime.sandboxId, signal);
    if (!sandbox || sandbox.id !== record.physicalSandboxId || sandbox.phase !== 'Ready')
      throw new Error('OpenShell failed lifecycle recovery requires a verified ready sandbox');
    const manifest = await new OpenShellCheckpointTransport(runtime).verify(
      record.checkpoint.path,
      checkpointIdentity(record, {
        sandboxId: record.checkpoint.sandboxId,
        resourceVersion: record.checkpoint.sourceResourceVersion,
      }),
      signal,
    );
    if (manifest.digest !== record.checkpoint.digest)
      throw new Error('OpenShell failed lifecycle recovery checkpoint digest mismatch');
    configured.store.upsert({
      ...record,
      phase: 'retained',
      generation: record.generation + 1,
      physicalSandboxId: runtime.sandboxId,
      lastActivityAt: Date.now(),
      idleSince: null,
      stoppedAt: null,
      stoppedResourceVersion: null,
      failure: null,
    });
    return;
  }
  if (record.phase !== 'deleted' && record.phase !== 'failed' && !replaced) return;
  if (
    !record.checkpoint ||
    !record.identity ||
    !record.checkpoint.sandboxId ||
    !record.checkpoint.sourceResourceVersion
  )
    throw new Error('OpenShell sandbox recovery requires a verified checkpoint');
  const restoring = configured.store.transition(conversationId, record.generation, 'restoring');
  if (!restoring) throw new Error('OpenShell lifecycle generation changed during restore');
  try {
    await new OpenShellCheckpointTransport(runtime).restore(
      record.checkpoint.path,
      checkpointIdentity(record, {
        sandboxId: record.checkpoint.sandboxId,
        resourceVersion: record.checkpoint.sourceResourceVersion,
      }),
      record.checkpoint.digest,
      signal,
    );
    configured.store.upsert({
      ...restoring,
      phase: 'retained',
      generation: restoring.generation + 1,
      physicalSandboxId: runtime.sandboxId ?? null,
      lastActivityAt: Date.now(),
      idleSince: null,
      stoppedAt: null,
      stoppedResourceVersion: null,
      failure: null,
    });
  } catch (error) {
    configured.store.upsert({
      ...restoring,
      phase: 'failed',
      generation: restoring.generation + 1,
      failure: error instanceof Error ? error.message : 'OpenShell checkpoint restore failed',
    });
    throw error;
  }
}

export function lifecycleService() {
  return configured?.service;
}

/** Synchronous queue admission marks activity before provider work is started.
 * It intentionally does not manufacture a lifecycle record for a session that
 * has not completed initial identity registration. */
export function touchOpenShellLifecycle(conversationId: string) {
  if (!configured) return true;
  if (!sharedOpenShellLifecycleCoordinator.tryAdmitActivity(conversationId)) return false;
  const record = configured.store.get(conversationId);
  if (!record || record.phase === 'deleted' || record.phase === 'failed') return true;
  const resumable =
    record.phase === 'checkpointing' || record.phase === 'stopping' || record.phase === 'deleting';
  configured.store.upsert({
    ...record,
    ...(resumable ? { phase: 'retained' as const } : {}),
    generation: record.generation + 1,
    lastActivityAt: Date.now(),
    idleSince: null,
  });
  return true;
}

/** Transport close alone is not eligibility; it only begins idle accounting.
 * The service still rechecks queue, Task Board, registry, and physical state. */
export function markOpenShellLifecycleIdle(conversationId: string) {
  if (!configured) return;
  const record = configured.store.get(conversationId);
  if (!record || record.phase !== 'retained') return;
  const now = Date.now();
  configured.store.upsert({
    ...record,
    generation: record.generation + 1,
    lastActivityAt: now,
    idleSince: now,
  });
}
