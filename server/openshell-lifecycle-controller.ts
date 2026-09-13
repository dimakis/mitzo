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
  openShellLifecyclePolicy,
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
  const policy = openShellLifecyclePolicy(process.env);
  // Lifecycle is explicitly opt-in. Do not make an otherwise usable
  // OpenShell runtime depend on the lifecycle checkpoint policy until it is
  // enabled, because only lifecycle needs to hash that file.
  if (!config || !policy.enabled) return undefined;
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
  managerFor(record);
  const replaced = record.physicalSandboxId !== runtime.sandboxId;
  if (record.phase !== 'deleted' && !replaced) return;
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
