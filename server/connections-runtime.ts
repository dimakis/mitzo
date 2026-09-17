import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ConnectionStore } from './connections-store.js';
import { ConnectionsService } from './connections-service.js';
import { OpenShellConnectionGateway } from './connections-gateway.js';
import { connectionTemplateRegistry } from './connections/registry.js';
import { CapabilityOperationStore } from './connections/capabilities/operation-store.js';
import { CapabilityExecutorRegistry } from './connections/capabilities/registry.js';
import { CapabilityService } from './connections/capabilities/service.js';
import type { CapabilityExecutor } from './connections/capabilities/types.js';
import { getLiveCapabilityConversationBinding } from './capability-conversation-binding.js';
import { createGithubPublishPrExecutor } from './connections/capabilities/github-publish-pr.js';
import {
  GitHubCliHostPublisher,
  OpenShellGithubSandboxTransport,
} from './connections/capabilities/github-publish-pr-transport.js';

const exec = promisify(execFile);
export interface ConnectionsRuntime {
  store: ConnectionStore;
  service: ConnectionsService;
  capabilityStore: CapabilityOperationStore;
  capabilities: CapabilityService;
  eligibleAccountIds: () => string[];
  gateway: string;
  workspace: string;
  legacyProviders: () => Promise<Array<{ name: string; type: string }>>;
}
let activeRuntime: ConnectionsRuntime | null = null;
export function setConnectionsRuntime(runtime: ConnectionsRuntime | null) {
  activeRuntime = runtime;
}
export function getConnectionsRuntime() {
  return activeRuntime;
}

/** Explicit bootstrap: no gateway process or filesystem work occurs at import. */
export function createConnectionsRuntime(options: {
  directory: string;
  eligibleAccountIds: () => string[];
  cli: string;
  workspace: string;
  gateway?: string;
  gatewayEndpoint?: string;
  gatewayInsecure?: boolean;
  legacyProviders?: string[];
  profilePath?: string;
  probeImage?: string;
  probePolicy?: string;
  githubProbePolicy?: string;
  /** Authoritative conversation metadata, injected by server startup. */
  resolveConversationBinding?: (conversationId: string) => { accountId: string } | undefined;
  /** Tests may replace a reviewed built-in executor with a deterministic fake. */
  capabilityExecutors?: Readonly<Record<string, CapabilityExecutor>>;
}): ConnectionsRuntime {
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  const store = new ConnectionStore(join(options.directory, 'connections.db'));
  const gatewayName = options.gateway ?? 'openshell';
  // An endpoint deployment may reuse an alias. Persist a one-way binding so a
  // later alias change cannot silently resolve a connection against another gateway.
  const gatewayBinding = options.gatewayEndpoint
    ? `endpoint:${createHash('sha256').update(options.gatewayEndpoint).digest('hex')}`
    : gatewayName;
  const gatewayArgs = options.gatewayEndpoint
    ? [
        '--gateway-endpoint',
        options.gatewayEndpoint,
        ...(options.gatewayInsecure ? ['--gateway-insecure'] : []),
      ]
    : ['--gateway', gatewayName];
  const gateway = new OpenShellConnectionGateway(
    async (args, run) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), run.timeoutMs);
      try {
        const signal = AbortSignal.any([run.signal, controller.signal]);
        const [command, ...rest] = args;
        if (!command) throw new Error('Gateway command is required');
        const pending = exec(options.cli, [command, ...gatewayArgs, ...rest], {
          env: {
            PATH: process.env.PATH ?? '',
            HOME: process.env.HOME ?? '',
            TMPDIR: process.env.TMPDIR ?? '',
            LANG: process.env.LANG ?? '',
            LC_ALL: process.env.LC_ALL ?? '',
            ...run.env,
          },
          signal,
          maxBuffer: 128 * 1024,
        });
        // openshell sandbox exec reads piped stdin to EOF before starting the
        // remote command. execFile leaves it open unless we close it explicitly.
        pending.child.stdin?.end();
        const result = await pending;
        return result.stdout;
      } finally {
        clearTimeout(timer);
      }
    },
    {
      workspace: options.workspace,
      ...(options.profilePath ? { profilePath: options.profilePath } : {}),
      probeImage: options.probeImage,
      probePolicy: options.probePolicy,
      githubProbePolicy: options.githubProbePolicy,
    },
  );
  const service = new ConnectionsService(store, gateway, {
    gateway: gatewayBinding,
    workspace: options.workspace,
    eligibleAccountIds: options.eligibleAccountIds,
  });
  const capabilityStore = new CapabilityOperationStore(join(options.directory, 'capabilities.db'));
  // This transport executes only code-owned OpenShell/git argument shapes. It
  // is separate from provider provisioning because bundle export needs a
  // larger (but still bounded) binary-safe response than control metadata.
  const runControl = async (
    args: readonly string[],
    run: { signal: AbortSignal; maxOutputBytes: number },
  ) => {
    const [command, ...rest] = args;
    if (!command) throw new Error('Gateway command is required');
    try {
      const pending = exec(options.cli, [command, ...gatewayArgs, ...rest], {
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          TMPDIR: process.env.TMPDIR ?? '',
          LANG: process.env.LANG ?? '',
          LC_ALL: process.env.LC_ALL ?? '',
        },
        signal: run.signal,
        maxBuffer: run.maxOutputBytes,
      });
      pending.child.stdin?.end();
      return (await pending).stdout;
    } catch {
      throw new Error('OpenShell control transport failed');
    }
  };
  const githubSandbox = new OpenShellGithubSandboxTransport(runControl, options.workspace);
  const githubHost = new GitHubCliHostPublisher();
  const githubExecutor = createGithubPublishPrExecutor({
    sandbox: githubSandbox,
    host: githubHost,
    resolveConversation: (operation) => {
      const live = getLiveCapabilityConversationBinding(operation.conversationId);
      if (
        !live ||
        live.connectionId !== operation.connectionId ||
        live.connectionRevision !== operation.connectionRevision ||
        !live.sandboxName ||
        !live.workspace
      )
        return undefined;
      return { sandboxName: live.sandboxName, workspace: live.workspace };
    },
    resolvePublicConfig: (operation) => {
      const connection = store.get(operation.connectionId);
      return connection &&
        connection.revision === operation.connectionRevision &&
        connection.templateId === 'github-readonly' &&
        connection.templateVersion === 1 &&
        connection.status === 'active'
        ? connection.publicConfig
        : undefined;
    },
  });
  const executorRegistry = new CapabilityExecutorRegistry({
    'github-publish-pr-v1': githubExecutor,
    ...(options.capabilityExecutors ?? {}),
  });
  const capabilities = new CapabilityService({
    store: capabilityStore,
    executorRegistry,
    getTemplate: (id, version) => connectionTemplateRegistry.getCapabilityTemplate(id, version),
    getConnection: (id) => store.get(id) ?? undefined,
    listConnections: () => store.list('operator'),
    isConnectionActiveForConversation: (connectionId, accountId, conversationId) => {
      const binding = options.resolveConversationBinding?.(conversationId);
      const live = getLiveCapabilityConversationBinding(conversationId);
      const connection = store.get(connectionId);
      return !!(
        binding &&
        binding.accountId === accountId &&
        live &&
        live.accountId === accountId &&
        live.connectionId === connectionId &&
        live.connectionRevision === connection?.revision &&
        connection &&
        connection.status === 'active' &&
        connection.desiredAccountIds.includes(accountId)
      );
    },
    // Every real caller supplies a forced PermissionHandler approval. This
    // fail-closed default makes accidental new call sites non-mutating.
    approve: async () => false,
  });
  return {
    store,
    service,
    capabilityStore,
    capabilities,
    eligibleAccountIds: options.eligibleAccountIds,
    gateway: gatewayBinding,
    workspace: options.workspace,
    legacyProviders: async () => {
      const configured = new Set(options.legacyProviders ?? []);
      if (!configured.size) return [];
      return (await gateway.list(AbortSignal.timeout(15_000)))
        .filter((provider) => configured.has(provider.name))
        .map((provider) => ({ name: provider.name, type: provider.type }));
    },
  };
}
