import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { McpServerConfig } from './mcp-config.js';
import { openShellSshProcessSpec } from './codex-app-server-client.js';

const Sandbox = z.object({
  id: z.string().min(1).optional(),
  resource_version: z.string().min(1).optional(),
  name: z.string(),
  phase: z.enum(['Ready', 'Stopped', 'Pending', 'Creating', 'Starting', 'Error']),
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
  workdir: string;
  appServerCommand: '/sandbox/run-mitzo-app-server' | '/sandbox/run-mitzo-subscription-app-server';
  cli: string;
  gateway: string;
  workspace: string;
  gatewayEndpoint?: string;
  gatewayInsecure: boolean;
}

export interface OpenShellRuntimeConfig {
  cli: string;
  image: string;
  policy: string;
  seed: string;
  serviceProviders: string[];
  workspace: string;
  gateway: string;
  gatewayEndpoint?: string;
  gatewayInsecure: boolean;
  createDetached: boolean;
  sandboxIdLength: number;
  workdir: string;
  webSearch: 'disabled' | 'live';
}

const SERVICE_PROVIDERS = new Set(['google-workspace', 'github']);

export interface BoundOpenShellRuntimeConfig extends OpenShellRuntimeConfig {
  account: OpenShellAccountRoute;
}

export type OpenShellAccountRoute =
  | { kind: 'api'; provider: string; model: string }
  | {
      kind: 'chatgpt-subscription';
      provider: string;
      providerType: 'openai-codex-oauth';
      providerId: string;
      grantId: string;
      model: string;
    };

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
  ) {
    this.run = run ?? ((args, signal) => command(config.cli, args, signal));
    this.runSsh = runSsh ?? ((args, signal) => command('ssh', args, signal));
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

  private async get(name: string, signal: AbortSignal) {
    try {
      return Sandbox.parse(
        JSON.parse(await this.run(['sandbox', ...this.base(), 'get', name, '-o', 'json'], signal)),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/not found|404|does not exist/i.test(message)) return undefined;
      throw error;
    }
  }

  /** Read-only inventory scoped to sandboxes carrying this runtime's provider label. */
  async inventory(signal: AbortSignal) {
    const sandboxes: z.infer<typeof Sandbox>[] = [];
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

  private async ownedSandbox(conversationId: string, physicalId: string, signal: AbortSignal) {
    const hash = createHash('sha256').update(conversationId).digest('hex');
    const current = await this.get(
      sandboxNameForConversation(conversationId, this.config.sandboxIdLength),
      signal,
    );
    const sandbox = current ?? (await this.get(legacySandboxNameForConversation(hash), signal));
    const expectedOwner = current ? hash.slice(0, 63) : hash;
    if (!sandbox) throw new Error('OpenShell sandbox is unavailable');
    if (sandbox.id !== physicalId) throw new Error('OpenShell sandbox identity changed');
    if (sandbox.labels?.['mitzo.conversation'] !== expectedOwner)
      throw new Error('OpenShell sandbox is not owned by this conversation');
    if (sandbox.labels?.['mitzo.account_provider'] !== this.config.account.provider)
      throw new Error('OpenShell sandbox has another account provider binding');
    return sandbox;
  }

  /** Stops only a current, owned Ready sandbox. Callers must fence policy separately. */
  async stop(conversationId: string, physicalId: string, signal: AbortSignal) {
    const sandbox = await this.ownedSandbox(conversationId, physicalId, signal);
    if (sandbox.phase !== 'Ready')
      throw new Error(`OpenShell sandbox is ${sandbox.phase}, not Ready`);
    await this.run(['sandbox', ...this.base(), 'stop', sandbox.name], signal);
  }

  /** Deletes only a current, owned Stopped sandbox. This is intentionally not an automatic policy. */
  async delete(conversationId: string, physicalId: string, signal: AbortSignal) {
    const sandbox = await this.ownedSandbox(conversationId, physicalId, signal);
    if (sandbox.phase !== 'Stopped')
      throw new Error(`OpenShell sandbox is ${sandbox.phase}, not Stopped`);
    await this.run(['sandbox', ...this.base(), 'delete', sandbox.name], signal);
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
    if (account.kind === 'api') return;
    const providers = ProviderList.parse(
      JSON.parse(
        await this.run(
          ['provider', ...this.base(), 'list', '--output', 'json', '--limit', '100'],
          signal,
        ),
      ),
    );
    const provider = providers.find((entry) => entry.name === account.provider);
    if (
      !provider ||
      provider.workspace !== this.config.workspace ||
      provider.type !== account.providerType ||
      provider.id !== account.providerId
    )
      throw new Error('OpenShell subscription provider does not match the selected account');
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

  async ensure(conversationId: string, signal: AbortSignal): Promise<OpenShellRuntime> {
    await this.verifyAccountProvider(signal);
    const accountProvider = this.config.account.provider;
    const conversationHash = createHash('sha256').update(conversationId).digest('hex');
    const currentName = sandboxNameForConversation(conversationId, this.config.sandboxIdLength);
    const currentOwner = conversationHash.slice(0, 63);
    let name = currentName;
    let owner = currentOwner;
    let sandbox = await this.get(name, signal);
    if (!sandbox) {
      const legacyName = legacySandboxNameForConversation(conversationHash);
      const legacy = await this.get(legacyName, signal);
      if (legacy) {
        name = legacyName;
        owner = conversationHash;
        sandbox = legacy;
      }
    }
    if (sandbox && sandbox.labels?.['mitzo.conversation'] !== owner)
      throw new Error(`OpenShell sandbox ${name} is not owned by this conversation`);
    if (sandbox && sandbox.labels?.['mitzo.account_provider'] !== accountProvider)
      throw new Error(`OpenShell sandbox ${name} has another account provider binding`);
    if (!sandbox) {
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
        '--no-auto-providers',
        '--output',
        'json',
      ];
      if (this.config.createDetached) args.push('--detach');
      args.push('--provider', accountProvider);
      // The reviewed subscription compatibility CLI requires an explicit
      // inference route. Released OpenShell 0.0.116 does not expose these
      // flags, and API providers already define their own inspected endpoint.
      if (this.config.account.kind === 'chatgpt-subscription') {
        args.push(
          '--inference-provider',
          accountProvider,
          '--inference-model',
          this.config.account.model,
        );
      }
      for (const provider of this.config.serviceProviders) args.push('--provider', provider);
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
    if (!sandbox || sandbox.phase !== 'Ready')
      throw new Error(`OpenShell sandbox ${name} is ${sandbox?.phase ?? 'unavailable'}`);
    if (sandbox.labels?.['mitzo.conversation'] !== owner)
      throw new Error(`OpenShell sandbox ${name} is not owned by this conversation`);
    return {
      sandboxName: name,
      workdir: this.config.workdir,
      appServerCommand:
        this.config.account.kind === 'chatgpt-subscription'
          ? '/sandbox/run-mitzo-subscription-app-server'
          : '/sandbox/run-mitzo-app-server',
      cli: this.config.cli,
      gateway: this.config.gateway,
      workspace: this.config.workspace,
      ...(this.config.gatewayEndpoint ? { gatewayEndpoint: this.config.gatewayEndpoint } : {}),
      gatewayInsecure: this.config.gatewayInsecure,
    };
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
