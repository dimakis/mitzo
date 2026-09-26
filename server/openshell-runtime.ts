import { parseProviderAttachments } from './connections-gateway.js';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import type { McpServerConfig } from './mcp-config.js';
import { openShellSshProcessSpec } from './codex-app-server-client.js';
import { codexPrivateDirectory } from './codex-private-path.js';
import type { ArtifactDriverConfig } from './symposium-artifact-lease.js';

// OpenShell gateways prior to the current API contract encode resource_version
// as a JSON number. Normalize that legacy representation at the boundary so
// checkpoint identity and CLI arguments always retain the string form.
const ResourceVersion = z.union([
  z.string().min(1),
  z.number().int().nonnegative().transform(String),
]);

const Sandbox = z.object({
  id: z.string().min(1).optional(),
  resource_version: ResourceVersion.optional(),
  // OpenShell increments resource_version for read-only status observations.
  // revision is the stable lifecycle fence for an already-stopped sandbox.
  revision: ResourceVersion.optional(),
  name: z.string(),
  phase: z.enum(['Ready', 'Stopped', 'Pending', 'Creating', 'Starting', 'Deleting', 'Error']),
  workspace: z.string().optional(),
  labels: z.record(z.string(), z.string()).optional(),
});
const SandboxList = z.array(Sandbox);
const Provider = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  workspace: z.string(),
  type: z.string().min(1),
});
const ProviderList = z.array(Provider);
const RefreshStatus = z.object({
  credentials: z.array(
    z.object({
      provider_name: z.string(),
      provider_id: z.string(),
      credential_key: z.string(),
      status: z.string(),
      expires_at_ms: z.number(),
      refresh_generation_id: z.string(),
    }),
  ),
});
const ContextSection = z.object({
  source: z.string(),
  heading: z.string(),
  tokens: z.number().int().nonnegative(),
  content: z.string(),
});
const BootContext = z.object({
  type: z.literal('boot_context'),
  scope: z.literal('sandbox'),
  sourceCount: z.number().int().nonnegative(),
  tokenCount: z.number().int().nonnegative(),
  tokenBudget: z.number().int().nonnegative(),
  sources: z.array(z.object({ path: z.string(), kind: z.string() })),
  included: z.array(ContextSection),
  trimmed: z.array(ContextSection),
  fullMarkdown: z.string(),
});
export type OpenShellBootContext = z.infer<typeof BootContext>;

export interface OpenShellRuntime {
  sandboxName: string;
  /** Immutable provider resource ID observed after ensure. */
  sandboxId?: string;
  resourceVersion?: string;
  created?: boolean;
  workdir: string;
  appServerCommand:
    | '/sandbox/run-mitzo-app-server'
    | '/sandbox/run-mitzo-subscription-app-server'
    | '/usr/local/bin/symposium-subscription-app-server';
  cli: string;
  gateway: string;
  workspace: string;
  gatewayEndpoint?: string;
  gatewayInsecure: boolean;
}

export interface OpenShellRuntimeConfig {
  /** Explicit CLI wire contract. Omitted retains the deployed 0.0.x behavior. */
  cliContract?: 'v0.1';
  /** Host-validated, lease-bound mount for a single seat. Never read from model output. */
  artifactDriverConfig?: ArtifactDriverConfig;
  /** Physical mount attestation supplied by the selected local compute driver. */
  verifyArtifactMount?: (
    sandboxName: string,
    sandboxId: string,
    config: ArtifactDriverConfig,
  ) => Promise<void>;
  cli: string;
  image: string;
  policy: string;
  seed: string;
  serviceProviders: string[];
  grantableServiceProviders: string[];
  workspace: string;
  gateway: string;
  gatewayEndpoint?: string;
  gatewayInsecure: boolean;
  createDetached: boolean;
  sandboxIdLength: number;
  workdir: string;
  webSearch: 'disabled' | 'live';
}

function assertArtifactDriverConfig(config: ArtifactDriverConfig): void {
  const keys = Object.keys(config);
  if (keys.length !== 1 || (keys[0] !== 'docker' && keys[0] !== 'podman'))
    throw new Error('Artifact driver config must select one local compute driver');
  const mounts = config[keys[0]]?.mounts;
  if (
    !Array.isArray(mounts) ||
    mounts.length !== 1 ||
    mounts[0].type !== 'volume' ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(mounts[0].source) ||
    mounts[0].target !== '/sandbox/symposium-artifacts' ||
    typeof mounts[0].read_only !== 'boolean' ||
    Object.keys(mounts[0]).sort().join(',') !== 'read_only,source,target,type'
  )
    throw new Error('Invalid artifact driver config');
}

const SERVICE_PROVIDERS = new Set(['google-workspace', 'github']);
/** Managed connection names only enter runtime configuration from ConnectionsService. */
const isServiceProviderName = (provider: string) =>
  SERVICE_PROVIDERS.has(provider) || /^mitzo-conn-[a-f0-9-]{8,64}$/.test(provider);
const PROVIDER_POLICY_LABEL = 'mitzo.provider_policy';
const PROVIDER_POLICY_VERSION = 'state-v2';
const PROVIDER_POLICY_QUEUES = new Map<string, Promise<void>>();

function providerPolicyFingerprint(serviceProviders: string[]) {
  return `${PROVIDER_POLICY_VERSION}-${[...new Set(serviceProviders)].sort().join('.') || 'none'}`;
}

interface ProviderPolicyRecord {
  automatic: string[];
  granted: string[];
  /** Previously managed attachments awaiting confirmed removal; never approval to attach. */
  pendingDetach?: string[];
}
interface ProviderPolicyState {
  read(sandboxName: string): ProviderPolicyRecord | undefined;
  write(sandboxName: string, record: ProviderPolicyRecord): void;
}

class FileProviderPolicyState implements ProviderPolicyState {
  private root = join(codexPrivateDirectory(), 'openshell-provider-policy');

  private path(sandboxName: string) {
    return join(this.root, `${identifier(sandboxName, 'sandbox')}.json`);
  }

  read(sandboxName: string) {
    const path = this.path(sandboxName);
    if (!existsSync(path)) return undefined;
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<ProviderPolicyRecord>;
    if (
      !Array.isArray(value.automatic) ||
      !Array.isArray(value.granted) ||
      !value.automatic.every(
        (provider) =>
          typeof provider === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(provider),
      ) ||
      !value.granted.every(
        (provider) => typeof provider === 'string' && isServiceProviderName(provider),
      ) ||
      (value.pendingDetach !== undefined &&
        (!Array.isArray(value.pendingDetach) ||
          !value.pendingDetach.every(
            (provider) =>
              typeof provider === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(provider),
          )))
    )
      throw new Error('OpenShell provider policy state is invalid');
    return {
      automatic: [...new Set(value.automatic)],
      granted: [...new Set(value.granted)],
      ...(value.pendingDetach ? { pendingDetach: [...new Set(value.pendingDetach)] } : {}),
    };
  }

  write(sandboxName: string, record: ProviderPolicyRecord) {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const path = this.path(sandboxName);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}

export interface BoundOpenShellRuntimeConfig extends OpenShellRuntimeConfig {
  account: OpenShellAccountRoute;
  /** Explicit, inventory-pinned inference providers for a shared Symposium sandbox. */
  accountProviderBindings?: readonly { name: string; type: string; id: string }[];
  /** Synchronous durable membership/union revision fence supplied by the session owner. */
  verifyAccountProviderUnion?: () => void;
  connectionAccountId?: string;
  enforceConnectionAttachments?: boolean;
  /**
   * The third argument is the durable, explicitly approved subset of
   * grantable providers for this retained sandbox. Callers must treat it as
   * an exact allowlist, not a set of candidates that may auto-attach.
   */
  verifyConnections?: (
    name: string,
    signal: AbortSignal,
    approvedGrantableProviders?: readonly string[],
  ) => Promise<void>;
}

export type OpenShellAccountRoute =
  | { kind: 'api'; provider: string; model: string }
  | {
      kind: 'chatgpt-subscription-native';
      provider: string;
      providerType: 'codex';
      providerId: string;
      model: string;
    }
  | {
      kind: 'chatgpt-subscription';
      provider: string;
      providerType: 'openai-codex-oauth';
      providerId: string;
      grantId: string;
      model: string;
    };

export type ServiceProviderAccess =
  | { state: 'available' }
  | { state: 'absent' }
  // The durable approval is still valid, but a verified Ready sandbox no
  // longer has its physical attachment (for example after an attach crash).
  | { state: 'approved-detached' }
  | { state: 'indeterminate'; error: Error };

type Run = (args: readonly string[], signal: AbortSignal) => Promise<string>;

function command(binary: string, args: readonly string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      [...args],
      {
        env: Object.fromEntries(
          ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'].flatMap((key) =>
            process.env[key] ? [[key, process.env[key]!]] : [],
          ),
        ),
        signal,
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

function identifier(value: string, label: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(value))
    throw new Error(`Invalid OpenShell ${label}`);
  return value;
}

export function openShellRuntimeConfig(env: NodeJS.ProcessEnv): OpenShellRuntimeConfig | undefined {
  if (env.MITZO_OPENSHELL_ENABLED !== '1') return undefined;
  if (env.MITZO_OPENSHELL_PROVIDERS)
    throw new Error(
      'MITZO_OPENSHELL_PROVIDERS is ambiguous; use MITZO_OPENSHELL_SERVICE_PROVIDERS.',
    );
  const image = env.MITZO_OPENSHELL_IMAGE;
  const policy = env.MITZO_OPENSHELL_POLICY;
  const seed = env.MITZO_OPENSHELL_SEED;
  if (!image || !policy || !seed) throw new Error('OpenShell runtime configuration is incomplete');
  const cli = env.MITZO_OPENSHELL_CLI || 'openshell';
  if ((cli !== 'openshell' && !isAbsolute(cli)) || !/^[A-Za-z0-9_./+-]+$/.test(cli))
    throw new Error('MITZO_OPENSHELL_CLI must be an absolute path');
  if (!isAbsolute(policy) || !isAbsolute(seed))
    throw new Error('OpenShell policy and seed paths must be absolute');
  const serviceProviders = (env.MITZO_OPENSHELL_SERVICE_PROVIDERS || '')
    .split(',')
    .filter(Boolean)
    .map((value) => identifier(value, 'service provider'));
  for (const provider of serviceProviders) {
    if (!SERVICE_PROVIDERS.has(provider))
      throw new Error(`OpenShell provider is not an allowed service provider: ${provider}`);
  }
  const grantableServiceProviders = (env.MITZO_OPENSHELL_GRANTABLE_SERVICE_PROVIDERS || '')
    .split(',')
    .filter(Boolean)
    .map((value) => identifier(value, 'grantable service provider'));
  for (const provider of grantableServiceProviders) {
    if (!SERVICE_PROVIDERS.has(provider))
      throw new Error(
        `OpenShell provider is not an allowed grantable service provider: ${provider}`,
      );
  }
  const overlappingProvider = serviceProviders.find((provider) =>
    grantableServiceProviders.includes(provider),
  );
  if (overlappingProvider)
    throw new Error(
      `OpenShell service provider cannot be both automatic and grantable: ${overlappingProvider}`,
    );
  const webSearch = env.MITZO_OPENSHELL_WEB_SEARCH || 'disabled';
  if (webSearch !== 'disabled' && webSearch !== 'live')
    throw new Error('Invalid OpenShell web search mode');
  const gatewayEndpoint = env.MITZO_OPENSHELL_GATEWAY_ENDPOINT;
  if (gatewayEndpoint && !/^https?:\/\/[A-Za-z0-9.:[\]_-]+(?::\d+)?$/.test(gatewayEndpoint))
    throw new Error('Invalid OpenShell gateway endpoint');
  const gatewayInsecure = env.MITZO_OPENSHELL_GATEWAY_INSECURE === '1';
  if (gatewayInsecure && !gatewayEndpoint?.startsWith('http://'))
    throw new Error('OpenShell insecure mode requires an explicit HTTP endpoint');
  const createDetached = env.MITZO_OPENSHELL_CREATE_DETACHED !== '0';
  const sandboxIdLength = Number(env.MITZO_OPENSHELL_SANDBOX_ID_LENGTH || '13');
  if (!Number.isInteger(sandboxIdLength) || sandboxIdLength < 8 || sandboxIdLength > 13)
    throw new Error('MITZO_OPENSHELL_SANDBOX_ID_LENGTH must be an integer from 8 to 13');
  return {
    cli,
    image,
    policy,
    seed,
    serviceProviders,
    grantableServiceProviders,
    workspace: identifier(env.OPENSHELL_WORKSPACE || 'default', 'workspace'),
    gateway: identifier(env.OPENSHELL_GATEWAY || 'openshell', 'gateway'),
    ...(gatewayEndpoint ? { gatewayEndpoint } : {}),
    gatewayInsecure,
    createDetached,
    sandboxIdLength,
    workdir: '/sandbox/workspaces/mgmt',
    webSearch,
  };
}

/** Builds Codex config for capabilities that execute inside OpenShell.
 * Host MCP definitions are deliberately omitted; credentials and egress remain
 * governed by the sandbox's provider and network policy. */
export function openShellCodexRuntimeConfig(
  config: Pick<OpenShellRuntimeConfig, 'webSearch'>,
  servers: Record<string, McpServerConfig>,
) {
  const runtime: Record<string, unknown> = { web_search: config.webSearch };
  for (const [name, server] of Object.entries(servers)) {
    if (server.execution !== 'sandbox') continue;
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`Invalid sandbox MCP name: ${name}`);
    if (!isAbsolute(server.command))
      throw new Error(`Sandbox MCP command must be absolute: ${name}`);
    if (server.env && Object.keys(server.env).length)
      throw new Error(`Sandbox MCP environment must use OpenShell providers: ${name}`);
    runtime[`mcp_servers.${name}.command`] = server.command;
    if (server.args?.length) runtime[`mcp_servers.${name}.args`] = server.args;
    runtime[`mcp_servers.${name}.enabled`] = true;
  }
  return runtime;
}

export function sandboxNameForConversation(conversationId: string, idLength = 13) {
  if (!Number.isInteger(idLength) || idLength < 8 || idLength > 13)
    throw new Error('OpenShell sandbox id length must be an integer from 8 to 13');
  return `mitzo-${createHash('sha256').update(conversationId).digest('hex').slice(0, idLength)}`;
}

function legacySandboxNameForConversation(conversationHash: string) {
  return `mitzo-${conversationHash.slice(0, 24)}`;
}

/** Owns lifecycle only. OpenShell owns process/filesystem/network enforcement and providers. */
export class OpenShellRuntimeManager {
  private run: Run;
  private runSsh: Run;

  constructor(
    private config: BoundOpenShellRuntimeConfig,
    run?: Run,
    private readiness: { pollIntervalMs: number; timeoutMs: number } = {
      pollIntervalMs: 250,
      timeoutMs: 30_000,
    },
    runSsh?: Run,
    private providerPolicyState: ProviderPolicyState = new FileProviderPolicyState(),
  ) {
    if (
      config.account.kind === 'chatgpt-subscription-native' &&
      (config.cliContract !== 'v0.1' ||
        config.accountProviderBindings?.length !== 1 ||
        config.accountProviderBindings[0].type !== 'codex' ||
        config.accountProviderBindings[0].id !== config.account.providerId)
    )
      throw new Error('Native ChatGPT requires one pinned upstream OpenShell 0.1 Codex provider');
    if (config.cliContract === 'v0.1') {
      if (
        (config.account.kind !== 'api' && config.account.kind !== 'chatgpt-subscription-native') ||
        config.accountProviderBindings?.length !== 1 ||
        config.accountProviderBindings[0].name !== config.account.provider ||
        config.serviceProviders.length ||
        config.grantableServiceProviders.length
      )
        throw new Error('OpenShell 0.1 seat sandbox requires exactly one account provider');
    }
    if (config.grantableServiceProviders.includes(config.account.provider))
      throw new Error(
        `OpenShell account provider cannot also be grantable: ${config.account.provider}`,
      );
    if (config.accountProviderBindings) {
      if (!config.verifyAccountProviderUnion)
        throw new Error('Shared account provider union requires a durable membership fence');
      if (config.account.kind !== 'api' && config.account.kind !== 'chatgpt-subscription-native')
        throw new Error('Shared account provider union requires independent API routes');
      const names = config.accountProviderBindings.map((binding) =>
        identifier(binding.name, 'account provider'),
      );
      if (new Set(names).size !== names.length || !names.includes(config.account.provider))
        throw new Error('Shared account provider bindings must be distinct and include the owner');
      if (
        names.some(
          (name) =>
            config.serviceProviders.includes(name) ||
            config.grantableServiceProviders.includes(name),
        )
      )
        throw new Error('Account provider cannot also be a service provider');
      for (const binding of config.accountProviderBindings) {
        identifier(binding.type, 'account provider type');
        if (!binding.id.trim()) throw new Error('Account provider ID is required');
      }
    }
    this.run = run ?? ((args, signal) => command(config.cli, args, signal));
    this.runSsh = runSsh ?? ((args, signal) => command('ssh', args, signal));
  }

  async hasServiceProviderAccess(
    conversationId: string,
    runtime: OpenShellRuntime,
    provider: string,
    signal: AbortSignal,
  ): Promise<ServiceProviderAccess> {
    if (this.config.serviceProviders.includes(provider)) return { state: 'available' };
    if (!this.config.grantableServiceProviders.includes(provider)) return { state: 'absent' };

    const owner = this.sandboxOwner(conversationId, runtime.sandboxName);
    if (!owner)
      return {
        state: 'indeterminate',
        error: new Error('OpenShell sandbox does not belong to this conversation'),
      };
    try {
      signal.throwIfAborted();
      const sandbox = await this.get(runtime.sandboxName, signal);
      if (!sandbox || sandbox.phase !== 'Ready')
        return {
          state: 'indeterminate',
          error: new Error(
            `OpenShell sandbox ${runtime.sandboxName} is ${sandbox?.phase ?? 'unavailable'}`,
          ),
        };
      if (sandbox.labels?.['mitzo.conversation'] !== owner)
        return {
          state: 'indeterminate',
          error: new Error(
            `OpenShell sandbox ${runtime.sandboxName} is not owned by this conversation`,
          ),
        };
      if (sandbox.labels?.['mitzo.account_provider'] !== this.config.account.provider)
        return {
          state: 'indeterminate',
          error: new Error(
            `OpenShell sandbox ${runtime.sandboxName} has another account provider binding`,
          ),
        };
      const attached = await this.attachedProviders(runtime.sandboxName, signal);
      const approved = this.providerPolicyState
        .read(runtime.sandboxName)
        ?.granted.includes(provider);
      if (!attached.includes(provider))
        return approved ? { state: 'approved-detached' } : { state: 'absent' };
      if (!approved)
        return {
          state: 'indeterminate',
          error: new Error(
            `OpenShell sandbox ${runtime.sandboxName} has an unapproved ${provider} attachment`,
          ),
        };
      return { state: 'available' };
    } catch (error) {
      if (signal.aborted) throw error;
      return {
        state: 'indeterminate',
        error:
          error instanceof Error
            ? error
            : new Error('OpenShell service provider availability could not be verified'),
      };
    }
  }

  private sandboxOwner(conversationId: string, sandboxName: string): string | undefined {
    const conversationHash = createHash('sha256').update(conversationId).digest('hex');
    if (sandboxName === sandboxNameForConversation(conversationId, this.config.sandboxIdLength))
      return conversationHash.slice(0, 63);
    if (sandboxName === legacySandboxNameForConversation(conversationHash)) return conversationHash;
    return undefined;
  }

  private base() {
    return [
      ...(this.config.gatewayEndpoint
        ? [
            '--gateway-endpoint',
            this.config.gatewayEndpoint,
            ...(this.config.gatewayInsecure ? ['--gateway-insecure'] : []),
          ]
        : ['--gateway', this.config.gateway]),
      '--workspace',
      this.config.workspace,
    ] as const;
  }

  private async attachedProviders(name: string, signal: AbortSignal): Promise<string[]> {
    const args = ['sandbox', ...this.base(), 'provider', 'list', name];
    if (this.config.cliContract !== 'v0.1')
      return parseProviderAttachments(await this.run(args, signal), name);
    // The 0.1 CLI emits a paginated envelope even for an empty attachment list.
    // A partial page is never sufficient evidence that another seat's provider
    // is absent, so consume every page before returning an authorization result.
    const attachments: { name: string; type: string }[] = [];
    let token = '';
    const seen = new Set<string>();
    do {
      const payload: unknown = JSON.parse(
        await this.run(
          [
            ...args,
            '--output',
            'json',
            '--page-size',
            '100',
            ...(token ? ['--page-token', token] : []),
          ],
          signal,
        ),
      );
      const page = z
        .object({
          providers: z.array(z.object({ name: z.string().min(1), type: z.string().min(1) })),
          next_page_token: z.string(),
        })
        .parse(payload);
      attachments.push(...page.providers);
      token = page.next_page_token;
      if (token && seen.has(token))
        throw new Error('OpenShell 0.1 attachment pagination repeated a token');
      if (token) seen.add(token);
    } while (token);
    const names = attachments.map((row) => row.name);
    if (new Set(names).size !== names.length)
      throw new Error('OpenShell 0.1 attachment inventory is invalid');
    const accountAttachment = attachments.find((row) => row.name === this.config.account.provider);
    if (
      accountAttachment &&
      accountAttachment.type !== this.config.accountProviderBindings?.[0]?.type
    )
      throw new Error('OpenShell 0.1 account attachment type changed');
    return names;
  }

  private async accountProviderInventory(signal: AbortSignal) {
    if (this.config.cliContract !== 'v0.1')
      return ProviderList.parse(
        JSON.parse(
          await this.run(
            ['provider', ...this.base(), 'list', '--output', 'json', '--limit', '100'],
            signal,
          ),
        ),
      );
    const providers: z.infer<typeof Provider>[] = [];
    let token = '';
    const seen = new Set<string>();
    do {
      const payload = JSON.parse(
        await this.run(
          [
            'provider',
            ...this.base(),
            'list',
            '--output',
            'json',
            '--page-size',
            '100',
            ...(token ? ['--page-token', token] : []),
          ],
          signal,
        ),
      ) as unknown;
      const page = z
        .object({ providers: ProviderList, next_page_token: z.string() })
        .parse(payload);
      providers.push(...page.providers);
      token = page.next_page_token;
      if (token && seen.has(token))
        throw new Error('OpenShell provider pagination repeated a token');
      if (token) seen.add(token);
    } while (token);
    return providers;
  }

  private async get(name: string, signal: AbortSignal) {
    try {
      const sandbox = Sandbox.parse(
        JSON.parse(await this.run(['sandbox', ...this.base(), 'get', name, '-o', 'json'], signal)),
      );
      if (
        this.config.cliContract === 'v0.1' &&
        (sandbox.name !== name || sandbox.workspace !== this.config.workspace)
      )
        throw new Error('OpenShell 0.1 sandbox name or workspace changed');
      return sandbox;
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/not found|404|does not exist/i.test(message)) return undefined;
      throw error;
    }
  }

  private async serializeProviderPolicy<T>(
    sandboxName: string,
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = PROVIDER_POLICY_QUEUES.get(sandboxName) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    PROVIDER_POLICY_QUEUES.set(sandboxName, tail);
    await previous.catch(() => undefined);
    try {
      signal.throwIfAborted();
      return await operation();
    } finally {
      release();
      if (PROVIDER_POLICY_QUEUES.get(sandboxName) === tail)
        PROVIDER_POLICY_QUEUES.delete(sandboxName);
    }
  }

  /** Read-only inventory scoped to sandboxes carrying this runtime's provider label. */
  async inventory(signal: AbortSignal) {
    const sandboxes: z.infer<typeof Sandbox>[] = [];
    if (this.config.cliContract === 'v0.1') {
      let token = '';
      const seen = new Set<string>();
      do {
        const payload = JSON.parse(
          await this.run(
            [
              'sandbox',
              ...this.base(),
              'list',
              '--output',
              'json',
              '--page-size',
              '100',
              ...(token ? ['--page-token', token] : []),
            ],
            signal,
          ),
        ) as unknown;
        const page = z
          .object({ sandboxes: SandboxList, next_page_token: z.string() })
          .parse(payload);
        sandboxes.push(...page.sandboxes);
        token = page.next_page_token;
        if (token && seen.has(token))
          throw new Error('OpenShell sandbox pagination repeated a token');
        if (token) seen.add(token);
      } while (token);
      return sandboxes.filter(
        (sandbox) =>
          sandbox.labels?.['mitzo.conversation'] &&
          sandbox.labels?.['mitzo.account_provider'] === this.config.account.provider &&
          sandbox.workspace === this.config.workspace,
      );
    }
    const limit = 100;
    for (let offset = 0; ; offset += limit) {
      const page = SandboxList.parse(
        JSON.parse(
          await this.run(
            [
              'sandbox',
              ...this.base(),
              'list',
              '--output',
              'json',
              '--limit',
              String(limit),
              '--offset',
              String(offset),
            ],
            signal,
          ),
        ),
      );
      sandboxes.push(...page);
      if (page.length < limit) break;
    }
    return sandboxes.filter(
      (sandbox) =>
        sandbox.labels?.['mitzo.conversation'] &&
        sandbox.labels?.['mitzo.account_provider'] === this.config.account.provider &&
        (!sandbox.workspace || sandbox.workspace === this.config.workspace),
    );
  }

  /** Read the current physical sandbox for a lifecycle record.  This keeps
   * lifecycle callers from reconstructing CLI arguments or trusting a name
   * without re-checking its ownership labels. */
  async inspect(conversationId: string, physicalId: string, signal: AbortSignal) {
    const sandbox = await this.ownedSandbox(conversationId, physicalId, signal, true);
    if (!sandbox) return undefined;
    if (!sandbox.id) throw new Error('OpenShell sandbox has no physical identity');
    // A Ready resource_version is an observation and may change after a read.
    // It is retained only in the checkpoint archive identity. A stopped
    // revision is stable and fences a later delete.
    const lifecycleVersion =
      sandbox.phase === 'Stopped' ? sandbox.revision : sandbox.resource_version;
    return {
      id: sandbox.id,
      ...(lifecycleVersion ? { resourceVersion: lifecycleVersion } : {}),
      phase: sandbox.phase,
    };
  }

  /** Recover a reserved runtime after a crash before its physical ID was recorded. */
  async inspectReserved(conversationId: string, signal: AbortSignal) {
    const name = sandboxNameForConversation(conversationId, this.config.sandboxIdLength);
    const sandbox = await this.get(name, signal);
    if (!sandbox) return undefined;
    const owner = createHash('sha256').update(conversationId).digest('hex').slice(0, 63);
    if (
      sandbox.labels?.['mitzo.conversation'] !== owner ||
      sandbox.labels?.['mitzo.account_provider'] !== this.config.account.provider ||
      (this.config.cliContract === 'v0.1' && sandbox.workspace !== this.config.workspace) ||
      !sandbox.id
    )
      throw new Error('Reserved OpenShell sandbox identity cannot be verified');
    return { id: sandbox.id, name: sandbox.name, phase: sandbox.phase };
  }

  private ownedSandbox(
    conversationId: string,
    physicalId: string,
    signal: AbortSignal,
  ): Promise<z.infer<typeof Sandbox>>;
  private ownedSandbox(
    conversationId: string,
    physicalId: string,
    signal: AbortSignal,
    allowAbsent: true,
  ): Promise<z.infer<typeof Sandbox> | undefined>;
  private async ownedSandbox(
    conversationId: string,
    physicalId: string,
    signal: AbortSignal,
    allowAbsent = false,
  ) {
    const hash = createHash('sha256').update(conversationId).digest('hex');
    const current = await this.get(
      sandboxNameForConversation(conversationId, this.config.sandboxIdLength),
      signal,
    );
    const sandbox = current ?? (await this.get(legacySandboxNameForConversation(hash), signal));
    const expectedOwner = current ? hash.slice(0, 63) : hash;
    if (!sandbox) {
      if (allowAbsent) return undefined;
      throw new Error('OpenShell sandbox is unavailable');
    }
    if (sandbox.id !== physicalId) throw new Error('OpenShell sandbox identity changed');
    if (sandbox.labels?.['mitzo.conversation'] !== expectedOwner)
      throw new Error('OpenShell sandbox is not owned by this conversation');
    if (sandbox.labels?.['mitzo.account_provider'] !== this.config.account.provider)
      throw new Error('OpenShell sandbox has another account provider binding');
    return sandbox;
  }

  /** Stops only a current, owned Ready sandbox. Callers must fence policy separately. */
  async stop(
    conversationId: string,
    physicalId: string,
    signal: AbortSignal,
    activityUnchanged?: () => boolean,
  ) {
    const sandbox = await this.ownedSandbox(conversationId, physicalId, signal);
    if (sandbox.phase !== 'Ready')
      throw new Error(`OpenShell sandbox is ${sandbox.phase}, not Ready`);
    if (activityUnchanged && !activityUnchanged())
      throw new Error('OpenShell lifecycle activity changed before stop');
    await this.run(['sandbox', ...this.base(), 'stop', sandbox.name], signal);
  }

  /** Deletes only a current, owned Stopped sandbox. This is intentionally not an automatic policy. */
  async delete(
    conversationId: string,
    physicalId: string,
    signal: AbortSignal,
    stateUnchanged?: () => boolean,
  ) {
    const sandbox = await this.ownedSandbox(conversationId, physicalId, signal);
    if (sandbox.phase !== 'Stopped')
      throw new Error(`OpenShell sandbox is ${sandbox.phase}, not Stopped`);
    if (stateUnchanged && !stateUnchanged())
      throw new Error('OpenShell lifecycle state changed before delete');
    await this.run(['sandbox', ...this.base(), 'delete', sandbox.name], signal);
    await this.waitForAbsent(conversationId, sandbox.name, physicalId, signal);
  }

  /** Gateway deletion is asynchronous. Do not report success while a same-named
   * physical sandbox still exists; a replacement is a hard identity failure. */
  private async waitForAbsent(
    conversationId: string,
    name: string,
    physicalId: string,
    signal: AbortSignal,
  ) {
    const hash = createHash('sha256').update(conversationId).digest('hex');
    const expectedOwner =
      name === sandboxNameForConversation(conversationId, this.config.sandboxIdLength)
        ? hash.slice(0, 63)
        : hash;
    const deadline = Date.now() + this.readiness.timeoutMs;
    while (Date.now() <= deadline) {
      signal.throwIfAborted();
      const timeout = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
      let sandbox: z.infer<typeof Sandbox> | undefined;
      try {
        sandbox = await this.get(name, AbortSignal.any([signal, timeout]));
      } catch (error) {
        if (signal.aborted || !timeout.aborted) throw error;
        break;
      }
      if (!sandbox) return;
      if (sandbox.id !== physicalId)
        throw new Error('OpenShell sandbox identity changed during delete');
      if (sandbox.labels?.['mitzo.conversation'] !== expectedOwner)
        throw new Error('OpenShell sandbox is not owned by this conversation');
      if (sandbox.labels?.['mitzo.account_provider'] !== this.config.account.provider)
        throw new Error('OpenShell sandbox has another account provider binding');
      await this.delay(signal);
    }
    throw new Error('OpenShell sandbox did not disappear after delete');
  }

  private delay(signal: AbortSignal) {
    signal.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('OpenShell readiness wait aborted'));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, this.readiness.pollIntervalMs);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private async verifyAccountProvider(signal: AbortSignal) {
    const account = this.config.account;
    if (this.config.accountProviderBindings) {
      const providers = await this.accountProviderInventory(signal);
      for (const binding of this.config.accountProviderBindings) {
        const matches = providers.filter((provider) => provider.name === binding.name);
        const match = matches[0];
        if (
          matches.length !== 1 ||
          !match ||
          match.workspace !== this.config.workspace ||
          match.type !== binding.type ||
          match.id !== binding.id
        )
          throw new Error('OpenShell account provider inventory changed');
      }
      return;
    }
    if (account.kind === 'api') return;
    const providers = await this.accountProviderInventory(signal);
    const provider = providers.find((entry) => entry.name === account.provider);
    if (
      !provider ||
      provider.workspace !== this.config.workspace ||
      provider.type !== account.providerType ||
      provider.id !== account.providerId
    )
      throw new Error('OpenShell subscription provider does not match the selected account');
    // Public native Codex providers use gateway-owned CODEX_AUTH_* refresh.
    // The compatibility OAuth provider's refresh contract does not apply.
    if (account.kind === 'chatgpt-subscription-native') return;
    const refresh = RefreshStatus.parse(
      JSON.parse(
        await this.run(
          ['provider', ...this.base(), 'refresh', 'status', account.provider, '--output', 'json'],
          signal,
        ),
      ),
    );
    const credential = refresh.credentials.find(
      (entry) => entry.credential_key === 'OPENAI_CODEX_OAUTH_ACCESS_TOKEN',
    );
    if (
      !credential ||
      credential.provider_name !== account.provider ||
      credential.provider_id !== account.providerId ||
      credential.status !== 'refreshed' ||
      credential.refresh_generation_id !== account.grantId ||
      credential.expires_at_ms <= Date.now()
    )
      throw new Error('OpenShell ChatGPT grant is expired, revoked, or requires sign-in');
  }

  private async waitForReady(name: string, owner: string, signal: AbortSignal) {
    const deadline = Date.now() + this.readiness.timeoutMs;
    let phase = 'unavailable';
    while (Date.now() <= deadline) {
      signal.throwIfAborted();
      const sandbox = await this.get(name, signal);
      phase = sandbox?.phase ?? 'unavailable';
      if (sandbox && sandbox.labels?.['mitzo.conversation'] !== owner)
        throw new Error(`OpenShell sandbox ${name} is not owned by this conversation`);
      if (sandbox && sandbox.labels?.['mitzo.account_provider'] !== this.config.account.provider)
        throw new Error(`OpenShell sandbox ${name} has another account provider binding`);
      if (sandbox?.phase === 'Ready') return sandbox;
      if (sandbox?.phase === 'Error') throw new Error(`OpenShell sandbox ${name} is Error`);
      await this.delay(signal);
    }
    throw new Error(`OpenShell sandbox ${name} did not become Ready (last phase: ${phase})`);
  }

  private async verifyManagedConnections(
    name: string,
    signal: AbortSignal,
    approvedGrantableProviders: readonly string[] = [],
  ) {
    await this.config.verifyConnections?.(name, signal, approvedGrantableProviders);
    if (this.config.enforceConnectionAttachments) {
      const actual = (await this.attachedProviders(name, signal)).filter((p) =>
        p.startsWith('mitzo-conn-'),
      );
      const expected = this.config.serviceProviders.filter((p) => p.startsWith('mitzo-conn-'));
      if (actual.length !== expected.length || actual.some((p) => !expected.includes(p)))
        throw new Error('Connection permissions changed. Start a new conversation.');
    }
  }
  private async reconcileServiceProviders(
    name: string,
    owner: string,
    attach: string[],
    detach: string[],
    signal: AbortSignal,
  ): Promise<void> {
    let changed = false;
    for (const provider of attach) {
      try {
        await this.run(
          [
            'sandbox',
            ...this.base(),
            'provider',
            'attach',
            name,
            provider,
            ...(this.config.cliContract === 'v0.1' ? ['--wait', '--output', 'json'] : []),
          ],
          signal,
        );
        changed = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (this.config.cliContract === 'v0.1' || !/already attached|conflict|409/i.test(message))
          throw new Error('OpenShell service provider reconciliation failed', { cause: error });
      }
    }
    for (const provider of detach) {
      try {
        await this.run(['sandbox', ...this.base(), 'provider', 'detach', name, provider], signal);
        changed = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (!/not attached|not found|404|does not exist/i.test(message))
          throw new Error('OpenShell service provider reconciliation failed', { cause: error });
      }
    }
    if (changed) await this.waitForReady(name, owner, signal);
  }

  async ensure(
    conversationId: string,
    signal: AbortSignal,
    expected?: { sandboxName: string; sandboxId: string },
  ): Promise<OpenShellRuntime> {
    const artifactConfig = this.config.artifactDriverConfig;
    if (artifactConfig && (this.config.cliContract !== 'v0.1' || !this.config.verifyArtifactMount))
      throw new Error('Artifact mount requires OpenShell 0.1 and physical mount attestation');
    if (artifactConfig) assertArtifactDriverConfig(artifactConfig);
    this.config.verifyAccountProviderUnion?.();
    await this.verifyAccountProvider(signal);
    this.config.verifyAccountProviderUnion?.();
    const accountProvider = this.config.account.provider;
    // The account provider is a separately-bound inference/account role. It
    // can happen to have a service-provider name (for example `github`), but
    // it is never part of the attachable service-provider policy.
    const automaticProviders = () => [
      ...new Set(
        [
          ...this.config.serviceProviders.filter((provider) => isServiceProviderName(provider)),
          ...(this.config.accountProviderBindings?.map((binding) => binding.name) ?? []),
        ].filter((provider) => provider !== accountProvider),
      ),
    ];
    const policyFingerprint = providerPolicyFingerprint(automaticProviders());
    const conversationHash = createHash('sha256').update(conversationId).digest('hex');
    const currentName = sandboxNameForConversation(conversationId, this.config.sandboxIdLength);
    const currentOwner = conversationHash.slice(0, 63);
    let name = currentName;
    let owner = currentOwner;
    let sandbox = await this.get(name, signal);
    if (
      expected &&
      (!sandbox ||
        sandbox.phase !== 'Ready' ||
        sandbox.id !== expected.sandboxId ||
        sandbox.name !== expected.sandboxName ||
        name !== expected.sandboxName)
    )
      throw new Error('Recorded seat sandbox physical identity changed or is not Ready');
    let created = false;
    if (!sandbox) {
      const legacyName = legacySandboxNameForConversation(conversationHash);
      const legacy = await this.get(legacyName, signal);
      if (legacy) {
        name = legacyName;
        owner = conversationHash;
        sandbox = legacy;
      }
    }
    const retained = Boolean(sandbox);
    if (sandbox && sandbox.labels?.['mitzo.conversation'] !== owner)
      throw new Error(`OpenShell sandbox ${name} is not owned by this conversation`);
    if (sandbox && sandbox.labels?.['mitzo.account_provider'] !== accountProvider)
      throw new Error(`OpenShell sandbox ${name} has another account provider binding`);
    const approvedGrantableProviders = sandbox
      ? (this.providerPolicyState.read(name)?.granted ?? []).filter((provider) =>
          this.config.grantableServiceProviders.includes(provider),
        )
      : [];
    if (sandbox) await this.verifyManagedConnections(name, signal, approvedGrantableProviders);
    else await this.config.verifyConnections?.(name, signal, []);
    if (!sandbox) {
      created = true;
      const args = [
        'sandbox',
        ...this.base(),
        'create',
        '--name',
        name,
        '--from',
        this.config.image,
        '--policy',
        this.config.policy,
        '--upload',
        // OpenShell uploads a source directory as a child of the destination.
        // Target the fixed parent so the MGMT seed lands at the canonical cwd
        // instead of /sandbox/workspaces/mgmt/mgmt.
        `${this.config.seed}:/sandbox/workspaces`,
        '--label',
        `mitzo.conversation=${owner}`,
        '--label',
        `mitzo.account_provider=${accountProvider}`,
        '--label',
        `${PROVIDER_POLICY_LABEL}=${policyFingerprint}`,
        '--no-auto-providers',
        '--output',
        'json',
      ];
      if (artifactConfig) args.push('--driver-config-json', JSON.stringify(artifactConfig));
      if (this.config.connectionAccountId)
        args.push('--label', `mitzo.connection_account=${this.config.connectionAccountId}`);
      if (this.config.createDetached) args.push('--detach');
      args.push('--provider', accountProvider);
      // The reviewed subscription compatibility CLI requires an explicit
      // inference route. Released OpenShell 0.0.116 does not expose these
      // flags, and API providers already define their own inspected endpoint.
      if (
        this.config.account.kind === 'chatgpt-subscription' &&
        this.config.cliContract !== 'v0.1'
      ) {
        args.push(
          '--inference-provider',
          accountProvider,
          '--inference-model',
          this.config.account.model,
        );
      }
      for (const provider of this.config.serviceProviders)
        if (provider !== accountProvider) args.push('--provider', provider);
      for (const binding of this.config.accountProviderBindings ?? [])
        if (binding.name !== accountProvider) args.push('--provider', binding.name);
      if (this.config.accountProviderBindings) {
        this.config.verifyAccountProviderUnion?.();
        this.providerPolicyState.write(name, { automatic: automaticProviders(), granted: [] });
      }
      try {
        await this.run(args, signal);
      } catch (error) {
        if (!/already exists|conflict|409/i.test(error instanceof Error ? error.message : ''))
          throw error;
      }
      sandbox = await this.waitForReady(name, owner, signal);
    } else if (sandbox.phase === 'Stopped') {
      await this.run(['sandbox', ...this.base(), 'start', name], signal);
      sandbox = await this.waitForReady(name, owner, signal);
    } else if (sandbox.phase !== 'Ready') {
      sandbox = await this.waitForReady(name, owner, signal);
    }
    await this.verifyManagedConnections(name, signal, approvedGrantableProviders);
    if (sandbox && sandbox.phase === 'Ready' && sandbox.labels?.['mitzo.conversation'] === owner) {
      await this.serializeProviderPolicy(name, signal, async () => {
        this.config.verifyAccountProviderUnion?.();
        const automatic = automaticProviders();
        const persisted = retained ? this.providerPolicyState.read(name) : undefined;
        const previous: ProviderPolicyRecord | undefined =
          persisted ??
          (retained && sandbox.labels?.[PROVIDER_POLICY_LABEL] === policyFingerprint
            ? { automatic, granted: [] }
            : undefined);
        const granted = (previous?.granted ?? []).filter(
          (provider) =>
            provider !== accountProvider &&
            this.config.grantableServiceProviders.includes(provider),
        );
        // Desired policy alone is not evidence of a live provider attachment:
        // an attach can fail after its approval record is durable. Conversely,
        // a physical grant without that record is unapproved and must be
        // detached. Read actual state before mutating either the sandbox or
        // policy; an unreadable list fails closed.
        const desired = new Set([
          ...(this.config.cliContract === 'v0.1' ? [accountProvider] : []),
          ...automatic,
          ...granted,
        ]);
        const actual = retained
          ? new Set(await this.attachedProviders(name, signal))
          : new Set<string>();
        if (
          this.config.cliContract === 'v0.1' &&
          [...actual].some((provider) => provider !== accountProvider)
        )
          throw new Error('OpenShell 0.1 seat sandbox has another provider attachment');
        const attach = retained ? [...desired].filter((provider) => !actual.has(provider)) : [];
        const detach = retained
          ? [...actual].filter(
              (provider) =>
                provider !== accountProvider &&
                (isServiceProviderName(provider) ||
                  previous?.automatic.includes(provider) ||
                  previous?.pendingDetach?.includes(provider)) &&
                !desired.has(provider),
            )
          : [];
        // Persist intended account attachments before an asynchronous attach.
        // If membership changes mid-call, the next revision can identify and
        // detach a stale attachment even when this operation returns unknown.
        if (this.config.accountProviderBindings)
          this.providerPolicyState.write(name, {
            automatic,
            granted,
            ...(detach.length ? { pendingDetach: detach } : {}),
          });
        await this.reconcileServiceProviders(name, owner, attach, detach, signal);
        this.config.verifyAccountProviderUnion?.();
        if (this.config.accountProviderBindings) {
          const confirmed = new Set(await this.attachedProviders(name, signal));
          const expected = new Set([accountProvider, ...desired]);
          if (
            confirmed.size !== expected.size ||
            [...expected].some((provider) => !confirmed.has(provider))
          )
            throw new Error('Shared Symposium provider attachments are not confirmed');
          this.config.verifyAccountProviderUnion?.();
        }
        // Clear removal history only after the physical attachment set is confirmed.
        this.providerPolicyState.write(name, { automatic, granted });
      });
    }
    if (!sandbox || sandbox.phase !== 'Ready')
      throw new Error(`OpenShell sandbox ${name} is ${sandbox?.phase ?? 'unavailable'}`);
    if (artifactConfig) {
      if (!sandbox.id) throw new Error('Artifact sandbox has no immutable physical identity');
      await this.config.verifyArtifactMount!(name, sandbox.id, artifactConfig);
      const afterMount = await this.get(name, signal);
      if (!afterMount || afterMount.id !== sandbox.id || afterMount.phase !== 'Ready')
        throw new Error('Artifact sandbox changed during mount attestation');
    }
    if (sandbox.labels?.['mitzo.conversation'] !== owner)
      throw new Error(`OpenShell sandbox ${name} is not owned by this conversation`);
    if (expected) {
      const current = await this.get(name, signal);
      if (
        !current ||
        current.phase !== 'Ready' ||
        current.id !== expected.sandboxId ||
        current.name !== expected.sandboxName
      )
        throw new Error('Recorded seat sandbox physical identity changed or is not Ready');
    }
    this.config.verifyAccountProviderUnion?.();
    return {
      sandboxName: name,
      ...(sandbox.id ? { sandboxId: sandbox.id } : {}),
      ...(sandbox.resource_version ? { resourceVersion: sandbox.resource_version } : {}),
      ...(created ? { created: true } : {}),
      workdir: this.config.workdir,
      appServerCommand:
        this.config.account.kind === 'chatgpt-subscription-native'
          ? '/usr/local/bin/symposium-subscription-app-server'
          : this.config.account.kind === 'chatgpt-subscription'
            ? '/sandbox/run-mitzo-subscription-app-server'
            : '/sandbox/run-mitzo-app-server',
      cli: this.config.cli,
      gateway: this.config.gateway,
      workspace: this.config.workspace,
      ...(this.config.gatewayEndpoint ? { gatewayEndpoint: this.config.gatewayEndpoint } : {}),
      gatewayInsecure: this.config.gatewayInsecure,
    };
  }

  async grantServiceProvider(
    conversationId: string,
    runtime: OpenShellRuntime,
    provider: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (provider === this.config.account.provider)
      throw new Error('OpenShell account provider cannot be granted as a service provider');
    if (!this.config.grantableServiceProviders.includes(provider))
      throw new Error('OpenShell service provider is not grantable');
    return this.serializeProviderPolicy(runtime.sandboxName, signal, async () => {
      const owner = this.sandboxOwner(conversationId, runtime.sandboxName);
      if (!owner) throw new Error('OpenShell sandbox does not belong to this conversation');
      const sandbox = await this.get(runtime.sandboxName, signal);
      if (!sandbox || sandbox.phase !== 'Ready')
        throw new Error(`OpenShell sandbox ${runtime.sandboxName} is not Ready`);
      if (sandbox.labels?.['mitzo.conversation'] !== owner)
        throw new Error(
          `OpenShell sandbox ${runtime.sandboxName} is not owned by this conversation`,
        );
      if (sandbox.labels?.['mitzo.account_provider'] !== this.config.account.provider)
        throw new Error(
          `OpenShell sandbox ${runtime.sandboxName} has another account provider binding`,
        );
      // Record desired policy before attach. A crash can only leave an
      // approved-but-missing attachment, which is safely verified as absent.
      const previous = this.providerPolicyState.read(runtime.sandboxName);
      this.providerPolicyState.write(runtime.sandboxName, {
        automatic: previous?.automatic?.filter(
          (configured) => configured !== this.config.account.provider,
        ) ?? [
          ...new Set(
            this.config.serviceProviders.filter(
              (configured) =>
                isServiceProviderName(configured) && configured !== this.config.account.provider,
            ),
          ),
        ],
        granted: [...new Set([...(previous?.granted ?? []), provider])],
        ...(previous?.pendingDetach ? { pendingDetach: previous.pendingDetach } : {}),
      });
      try {
        await this.run(
          ['sandbox', ...this.base(), 'provider', 'attach', runtime.sandboxName, provider],
          signal,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (!/already attached|conflict|409/i.test(message))
          throw new Error('OpenShell service provider grant failed', { cause: error });
      }
      await this.waitForReady(runtime.sandboxName, owner, signal);
    });
  }

  async revokeServiceProvider(
    conversationId: string,
    runtime: OpenShellRuntime,
    provider: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.config.grantableServiceProviders.includes(provider))
      throw new Error('OpenShell service provider is not grantable');
    return this.serializeProviderPolicy(runtime.sandboxName, signal, async () => {
      const owner = this.sandboxOwner(conversationId, runtime.sandboxName);
      if (!owner) throw new Error('OpenShell sandbox does not belong to this conversation');
      const sandbox = await this.get(runtime.sandboxName, signal);
      if (!sandbox || sandbox.phase !== 'Ready')
        throw new Error(`OpenShell sandbox ${runtime.sandboxName} is not Ready`);
      if (
        sandbox.labels?.['mitzo.conversation'] !== owner ||
        sandbox.labels?.['mitzo.account_provider'] !== this.config.account.provider
      )
        throw new Error('OpenShell sandbox binding changed');
      const previous = this.providerPolicyState.read(runtime.sandboxName);
      this.providerPolicyState.write(runtime.sandboxName, {
        automatic: previous?.automatic ?? [],
        granted: (previous?.granted ?? []).filter((granted) => granted !== provider),
        ...(previous?.pendingDetach ? { pendingDetach: previous.pendingDetach } : {}),
      });
      try {
        await this.run(
          ['sandbox', ...this.base(), 'provider', 'detach', runtime.sandboxName, provider],
          signal,
        );
      } catch (error) {
        if (
          !/not attached|not found|404|does not exist/i.test(
            error instanceof Error ? error.message : '',
          )
        )
          throw new Error('OpenShell service provider revoke failed', { cause: error });
      }
      await this.waitForReady(runtime.sandboxName, owner, signal);
    });
  }

  async compileContext(runtime: OpenShellRuntime, signal: AbortSignal) {
    const spec = openShellSshProcessSpec(
      runtime,
      `/usr/bin/node /sandbox/compile-mgmt-context.mjs ${runtime.workdir} 12000`,
    );
    const output = await this.runSsh(spec.args, signal);
    return BootContext.parse(JSON.parse(output.trim()));
  }
}
