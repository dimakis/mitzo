import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountBinding } from '@mitzo/protocol';
import { codexPrivateDirectory } from './codex-private-path.js';
import { OpenShellCheckpointTransport, type CheckpointIdentity } from './openshell-checkpoint-transport.js';
import {
  OpenShellLifecycleStore,
  openShellLifecyclePolicy,
  type OpenShellLifecycleIdentity,
  type OpenShellLifecycleRecord,
} from './openshell-lifecycle.js';
import { createOpenShellLifecycleProductionAdapter } from './openshell-lifecycle-production.js';
import { OpenShellLifecycleService } from './openshell-lifecycle-service.js';
import {
  OpenShellRuntimeManager,
  type BoundOpenShellRuntimeConfig,
  type OpenShellAccountRoute,
  type OpenShellRuntime,
  type OpenShellRuntimeConfig,
} from './openshell-runtime.js';

interface ProtectionSources {
  registry: Parameters<typeof createOpenShellLifecycleProductionAdapter>[0]['registry'];
  eventStore: Parameters<typeof createOpenShellLifecycleProductionAdapter>[0]['eventStore'];
  taskStore: Parameters<typeof createOpenShellLifecycleProductionAdapter>[0]['taskStore'];
  queue: Parameters<typeof createOpenShellLifecycleProductionAdapter>[0]['queue'];
}

let configured:
  | {
      config: OpenShellRuntimeConfig;
      policyDigest: string;
      store: OpenShellLifecycleStore;
      service: OpenShellLifecycleService;
    }
  | undefined;

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

function checkpointIdentity(record: OpenShellLifecycleRecord, resourceVersion: string): CheckpointIdentity {
  const identity = record.identity;
  if (!identity || !record.physicalSandboxId)
    throw new Error('OpenShell lifecycle identity is unavailable');
  return {
    conversation: record.conversationId,
    thread: identity.threadId,
    binding: JSON.stringify([identity.accountId, identity.provider, identity.model, identity.profileRevision]),
    image: identity.image,
    policy: identity.policyDigest,
    sandboxId: record.physicalSandboxId,
    resourceVersion,
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
  if (!config) return undefined;
  const directory = codexPrivateDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const store = new OpenShellLifecycleStore(join(directory, 'openshell-lifecycle.db'));
  store.reconcileInterrupted();
  configured = {
    config,
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
    stop: (record, signal) => {
      if (!record.physicalSandboxId) return Promise.reject(new Error('OpenShell sandbox identity missing'));
      return managerFor(record).stop(record.conversationId, record.physicalSandboxId, signal);
    },
    delete: (record, signal) => {
      if (!record.physicalSandboxId) return Promise.reject(new Error('OpenShell sandbox identity missing'));
      return managerFor(record).delete(record.conversationId, record.physicalSandboxId, signal);
    },
    checkpoint: async (record, sandbox, signal) => {
      if (!sandbox.resourceVersion) throw new Error('OpenShell sandbox resource version is unavailable');
      const transport = new OpenShellCheckpointTransport(runtimeFor(record));
      const result = await transport.capture(
        join(directory, 'openshell-checkpoints', record.conversationId, String(record.generation)),
        checkpointIdentity(record, sandbox.resourceVersion),
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
      if (!version) return false;
      const manifest = await new OpenShellCheckpointTransport(runtimeFor(record)).verify(
        record.checkpoint.path,
        checkpointIdentity(record, version),
        signal,
      );
      return manifest.digest === record.checkpoint.digest && manifest.sandboxId === sandbox.id;
    },
  });
  const service = new OpenShellLifecycleService(store, openShellLifecyclePolicy(process.env), adapter);
  configured.service = service;
  return { service, store, policy: openShellLifecyclePolicy(process.env) };
}

export function registerOpenShellLifecycle(
  conversationId: string,
  runtime: OpenShellRuntime,
  binding: AccountBinding,
  account: OpenShellAccountRoute,
  threadId: string,
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
      phase: 'retained',
      generation: (existing?.generation ?? 0) + 1,
      lastActivityAt: now,
      idleSince: null,
      stoppedAt: null,
      checkpoint: existing?.checkpoint ?? null,
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
) {
  if (!configured) return;
  const record = configured.store.get(conversationId);
  if (!record) return;
  const replaced = record.physicalSandboxId !== runtime.sandboxId;
  if (record.phase !== 'deleted' && !replaced) return;
  if (!record.checkpoint || !record.identity || !record.checkpoint.sourceResourceVersion)
    throw new Error('OpenShell sandbox recovery requires a verified checkpoint');
  const restoring = configured.store.transition(conversationId, record.generation, 'restoring');
  if (!restoring) throw new Error('OpenShell lifecycle generation changed during restore');
  try {
    await new OpenShellCheckpointTransport(runtime).restore(
      record.checkpoint.path,
      checkpointIdentity(record, record.checkpoint.sourceResourceVersion),
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
  if (!configured) return;
  const record = configured.store.get(conversationId);
  if (!record || record.phase === 'deleted' || record.phase === 'failed') return;
  configured.store.upsert({
    ...record,
    generation: record.generation + 1,
    lastActivityAt: Date.now(),
    idleSince: null,
  });
}
