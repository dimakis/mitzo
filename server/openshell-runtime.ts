import { parseProviderAttachments } from './connections-gateway.js';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { McpServerConfig } from './mcp-config.js';
import { openShellSshProcessSpec } from './codex-app-server-client.js';
import { codexPrivateDirectory } from './codex-private-path.js';

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
  /** Trusted production stack lock. Required only for dynamic current/mgmt seeds. */
  stackManifest?: string;
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

interface DynamicSeedBaselineFile {
  sha256: string;
  mode: string;
}

interface DynamicSeedBaseline {
  startingCommit: string;
  runtimeBaseCommit: string;
  runtimeDependencyProjectionSha256: string;
  payloadSha256: string;
  files: Record<string, DynamicSeedBaselineFile>;
}

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function compareUtf8(left: string, right: string) {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

/**
 * Canonical JSON shared with the release publisher: compact UTF-8 JSON whose
 * object keys are sorted by UTF-8 byte sequence.  Do not use localeCompare:
 * it is locale-sensitive and does not agree with Python's Unicode ordering.
 */
export function canonicalSeedJson(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry && typeof entry === 'object') {
      const object = entry as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(object)
          .sort(compareUtf8)
          .map((key) => [key, normalize(object[key])]),
      );
    }
    return entry;
  };
  return JSON.stringify(normalize(value));
}

function dynamicSeedReleaseRoot(seed: string): string | undefined {
  const components = seed.split(sep).filter(Boolean);
  const currentIndex = components.length - 2;
  if (components[currentIndex] !== 'current' || components.at(-1) !== 'mgmt') return undefined;
  return resolve(sep, ...components.slice(0, currentIndex));
}

function sameIdentity(left: ReturnType<typeof lstatSync>, right: ReturnType<typeof lstatSync>) {
  return !!left && !!right && left.dev === right.dev && left.ino === right.ino;
}

const SERVICE_PROVIDERS = new Set(['google-workspace', 'github']);
const PROVIDER_POLICY_LABEL = 'mitzo.provider_policy';
const PROVIDER_POLICY_VERSION = 'state-v2';
const PROVIDER_POLICY_QUEUES = new Map<string, Promise<void>>();

function providerPolicyFingerprint(serviceProviders: string[]) {
  return `${PROVIDER_POLICY_VERSION}-${[...new Set(serviceProviders)].sort().join('.') || 'none'}`;
}

interface ProviderPolicyRecord {
  automatic: string[];
  granted: string[];
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
      ![...value.automatic, ...value.granted].every(
        (provider) => typeof provider === 'string' && SERVICE_PROVIDERS.has(provider),
      )
    )
      throw new Error('OpenShell provider policy state is invalid');
    return { automatic: [...new Set(value.automatic)], granted: [...new Set(value.granted)] };
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
  connectionAccountId?: string;
  enforceConnectionAttachments?: boolean;
  verifyConnections?: (name: string, signal: AbortSignal) => Promise<void>;
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

/**
 * A dynamic release is configured as <release-root>/current/mgmt. Resolve that
 * one mutable pointer exactly once, immediately before creating a sandbox. The
 * returned path contains no `current` component, so a later updater swap cannot
 * alter the upload selected for this sandbox. Static/legacy seeds deliberately
 * retain their existing direct-path behavior.
 */
export function resolveImmutableSeed(seed: string): string {
  const configuredReleaseRoot = dynamicSeedReleaseRoot(seed);
  // Only the documented <release-root>/current/mgmt suffix is dynamic. A
  // static deployment may legitimately contain another directory named current.
  if (!configuredReleaseRoot) return seed;
  let releaseRoot: string;
  try {
    releaseRoot = realpathSync(configuredReleaseRoot);
  } catch {
    throw new Error('OpenShell dynamic seed release root is missing');
  }
  const current = join(releaseRoot, 'current');
  const before = lstatSync(current, { bigint: true });
  if (!before.isSymbolicLink()) throw new Error('OpenShell dynamic seed current is not a symlink');

  let release: string;
  try {
    release = realpathSync(current);
  } catch {
    throw new Error('OpenShell dynamic seed current is dangling');
  }
  const after = lstatSync(current, { bigint: true });
  if (
    !after.isSymbolicLink() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mtimeNs !== after.mtimeNs
  )
    throw new Error('OpenShell dynamic seed current changed while it was being resolved');
  const releasedRelative = relative(releaseRoot, release);
  if (!releasedRelative || releasedRelative === '..' || releasedRelative.startsWith(`..${sep}`))
    throw new Error('OpenShell dynamic seed current escapes its immutable release root');
  if (!lstatSync(release).isDirectory())
    throw new Error('OpenShell dynamic seed current does not resolve to a release directory');

  const resolvedSeed = realpathSync(join(release, 'mgmt'));
  const seedRelative = relative(release, resolvedSeed);
  if (!seedRelative || seedRelative === '..' || seedRelative.startsWith(`..${sep}`))
    throw new Error('OpenShell dynamic seed escapes its immutable release');
  if (!lstatSync(resolvedSeed).isDirectory())
    throw new Error('OpenShell dynamic seed does not resolve to a directory');
  return resolvedSeed;
}

function readJson(path: string, label: string): unknown {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`OpenShell dynamic seed ${label} is missing`);
  }
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new Error(`OpenShell dynamic seed ${label} is not a regular file`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`OpenShell dynamic seed ${label} is malformed`);
  }
}

function dynamicBaseline(value: unknown): DynamicSeedBaseline {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('OpenShell dynamic seed baseline is malformed');
  const baseline = value as Partial<DynamicSeedBaseline>;
  if (
    typeof baseline.startingCommit !== 'string' ||
    !COMMIT.test(baseline.startingCommit) ||
    typeof baseline.runtimeBaseCommit !== 'string' ||
    !COMMIT.test(baseline.runtimeBaseCommit) ||
    typeof baseline.runtimeDependencyProjectionSha256 !== 'string' ||
    !SHA256.test(baseline.runtimeDependencyProjectionSha256) ||
    typeof baseline.payloadSha256 !== 'string' ||
    !SHA256.test(baseline.payloadSha256) ||
    !baseline.files ||
    typeof baseline.files !== 'object' ||
    Array.isArray(baseline.files)
  )
    throw new Error('OpenShell dynamic seed baseline is malformed');
  for (const [path, entry] of Object.entries(baseline.files)) {
    if (
      !path ||
      path.startsWith('/') ||
      path.split('/').includes('..') ||
      !entry ||
      typeof entry !== 'object' ||
      !SHA256.test((entry as DynamicSeedBaselineFile).sha256) ||
      !/^[0-7]{4}$/.test((entry as DynamicSeedBaselineFile).mode)
    )
      throw new Error('OpenShell dynamic seed baseline file manifest is malformed');
  }
  return baseline as DynamicSeedBaseline;
}

function dynamicStackLock(value: unknown) {
  const runtime = (value as { runtime?: unknown } | undefined)?.runtime;
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime))
    throw new Error('OpenShell dynamic seed stack lock is malformed');
  const stack = runtime as Record<string, unknown>;
  if (
    typeof stack.mgmtSourceCommit !== 'string' ||
    !COMMIT.test(stack.mgmtSourceCommit) ||
    typeof stack.dependencyProjectionSha256 !== 'string' ||
    !SHA256.test(stack.dependencyProjectionSha256) ||
    typeof stack.seedPayloadSha256 !== 'string' ||
    !SHA256.test(stack.seedPayloadSha256)
  )
    throw new Error('OpenShell dynamic seed stack lock is malformed');
  return stack as {
    mgmtSourceCommit: string;
    dependencyProjectionSha256: string;
    seedPayloadSha256: string;
  };
}

function verifyDynamicSeedFiles(seed: string, baseline: DynamicSeedBaseline) {
  const root = realpathSync(seed);
  const expected = new Map(Object.entries(baseline.files));
  const actual = new Map<string, DynamicSeedBaselineFile>();
  const walk = (directory: string, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink())
        throw new Error(`OpenShell dynamic seed contains an unsafe symlink: ${path}`);
      if (stat.isDirectory()) walk(absolute, path);
      else if (stat.isFile()) {
        actual.set(path, {
          sha256: createHash('sha256').update(readFileSync(absolute)).digest('hex'),
          mode: (stat.mode & 0o7777).toString(8).padStart(4, '0'),
        });
      } else throw new Error(`OpenShell dynamic seed contains an unsupported path: ${path}`);
    }
  };
  walk(root);
  if (
    actual.size !== expected.size ||
    [...actual.keys()].some((path) => !expected.has(path)) ||
    [...expected.keys()].some((path) => !actual.has(path))
  )
    throw new Error('OpenShell dynamic seed files do not exactly match its baseline');
  for (const [path, expectedFile] of expected) {
    const actualFile = actual.get(path)!;
    if (actualFile.sha256 !== expectedFile.sha256 || actualFile.mode !== expectedFile.mode)
      throw new Error(`OpenShell dynamic seed file hash or mode does not match baseline: ${path}`);
  }
}

/**
 * Resolve and validate a dynamic seed at the last possible point before its
 * upload.  This is intentionally one operation: callers retain only the
 * concrete release path it returns and never dereference `current` again.
 */
export function verifyImmutableDynamicSeed(seed: string, stackManifest: string): string {
  if (!dynamicSeedReleaseRoot(seed)) return seed;
  if (!isAbsolute(stackManifest))
    throw new Error('OpenShell dynamic seed requires an absolute stack manifest path');
  const resolvedSeed = resolveImmutableSeed(seed);
  const before = lstatSync(resolvedSeed);
  const release = resolve(resolvedSeed, '..');
  const baseline = dynamicBaseline(readJson(join(release, 'baseline.json'), 'baseline'));
  const stack = dynamicStackLock(readJson(stackManifest, 'stack lock'));
  if (baseline.runtimeBaseCommit !== stack.mgmtSourceCommit)
    throw new Error('OpenShell dynamic seed runtime base does not match the stack lock');
  if (baseline.runtimeDependencyProjectionSha256 !== stack.dependencyProjectionSha256)
    throw new Error('OpenShell dynamic seed dependency projection does not match the stack lock');
  const manifestDigest = createHash('sha256')
    .update(canonicalSeedJson(baseline.files), 'utf8')
    .digest('hex');
  if (manifestDigest !== baseline.payloadSha256)
    throw new Error('OpenShell dynamic seed payload digest does not match baseline');
  if (manifestDigest !== stack.seedPayloadSha256)
    throw new Error('OpenShell dynamic seed payload digest does not match the stack lock');
  verifyDynamicSeedFiles(resolvedSeed, baseline);
  const after = lstatSync(resolvedSeed);
  if (!sameIdentity(before, after) || !after.isDirectory())
    throw new Error('OpenShell dynamic seed changed while it was being verified');
  return resolvedSeed;
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
  const stackManifest = env.MITZO_OPENSHELL_STACK_MANIFEST;
  if (!image || !policy || !seed) throw new Error('OpenShell runtime configuration is incomplete');
  const cli = env.MITZO_OPENSHELL_CLI || 'openshell';
  if ((cli !== 'openshell' && !isAbsolute(cli)) || !/^[A-Za-z0-9_./+-]+$/.test(cli))
    throw new Error('MITZO_OPENSHELL_CLI must be an absolute path');
  if (!isAbsolute(policy) || !isAbsolute(seed))
    throw new Error('OpenShell policy and seed paths must be absolute');
  if (stackManifest && !isAbsolute(stackManifest))
    throw new Error('MITZO_OPENSHELL_STACK_MANIFEST must be an absolute path');
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
    ...(stackManifest ? { stackManifest } : {}),
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

  private async verifyManagedConnections(name: string, signal: AbortSignal) {
    await this.config.verifyConnections?.(name, signal);
    if (this.config.enforceConnectionAttachments) {
      const actual = parseProviderAttachments(
        await this.run(['sandbox', ...this.base(), 'provider', 'list', name], signal),
        name,
      ).filter((p) => p.startsWith('mitzo-conn-'));
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
        await this.run(['sandbox', ...this.base(), 'provider', 'attach', name, provider], signal);
        changed = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (!/already attached|conflict|409/i.test(message))
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

  async ensure(conversationId: string, signal: AbortSignal): Promise<OpenShellRuntime> {
    await this.verifyAccountProvider(signal);
    const accountProvider = this.config.account.provider;
    const policyFingerprint = providerPolicyFingerprint(
      this.config.serviceProviders.filter((p) => SERVICE_PROVIDERS.has(p)),
    );
    const conversationHash = createHash('sha256').update(conversationId).digest('hex');
    const currentName = sandboxNameForConversation(conversationId, this.config.sandboxIdLength);
    const currentOwner = conversationHash.slice(0, 63);
    let name = currentName;
    let owner = currentOwner;
    let sandbox = await this.get(name, signal);
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
    if (sandbox) await this.verifyManagedConnections(name, signal);
    else await this.config.verifyConnections?.(name, signal);
    if (!sandbox) {
      created = true;
      // Pin and fully validate a dynamic `current` release at the final upload
      // boundary. Do not retain its mutable spelling or dereference it again.
      const seed = dynamicSeedReleaseRoot(this.config.seed)
        ? verifyImmutableDynamicSeed(this.config.seed, this.config.stackManifest ?? '')
        : this.config.seed;
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
        `${seed}:/sandbox/workspaces`,
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
      if (this.config.connectionAccountId)
        args.push('--label', `mitzo.connection_account=${this.config.connectionAccountId}`);
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
    await this.verifyManagedConnections(name, signal);
    if (sandbox && sandbox.phase === 'Ready' && sandbox.labels?.['mitzo.conversation'] === owner) {
      await this.serializeProviderPolicy(name, signal, async () => {
        const automatic = [
          ...new Set(this.config.serviceProviders.filter((p) => SERVICE_PROVIDERS.has(p))),
        ];
        const persisted = retained ? this.providerPolicyState.read(name) : undefined;
        const previous =
          persisted ??
          (retained && sandbox.labels?.[PROVIDER_POLICY_LABEL] === policyFingerprint
            ? { automatic, granted: [] }
            : undefined);
        const granted = (previous?.granted ?? []).filter((provider) =>
          this.config.grantableServiceProviders.includes(provider),
        );
        const desired = new Set([this.config.account.provider, ...automatic, ...granted]);
        const previouslyAttached = new Set([
          ...(previous?.automatic ?? []),
          ...(previous?.granted ?? []),
        ]);
        const attach = retained
          ? automatic.filter((provider) => !previouslyAttached.has(provider))
          : [];
        const detach = retained
          ? [...(previous ? previouslyAttached : SERVICE_PROVIDERS)].filter(
              (provider) => !desired.has(provider),
            )
          : [];
        await this.reconcileServiceProviders(name, owner, attach, detach, signal);
        this.providerPolicyState.write(name, { automatic, granted });
      });
    }
    if (!sandbox || sandbox.phase !== 'Ready')
      throw new Error(`OpenShell sandbox ${name} is ${sandbox?.phase ?? 'unavailable'}`);
    if (sandbox.labels?.['mitzo.conversation'] !== owner)
      throw new Error(`OpenShell sandbox ${name} is not owned by this conversation`);
    return {
      sandboxName: name,
      ...(sandbox.id ? { sandboxId: sandbox.id } : {}),
      ...(sandbox.resource_version ? { resourceVersion: sandbox.resource_version } : {}),
      ...(created ? { created: true } : {}),
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

  async grantServiceProvider(
    conversationId: string,
    runtime: OpenShellRuntime,
    provider: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.config.grantableServiceProviders.includes(provider))
      throw new Error('OpenShell service provider is not grantable');
    return this.serializeProviderPolicy(runtime.sandboxName, signal, async () => {
      const conversationHash = createHash('sha256').update(conversationId).digest('hex');
      const currentName = sandboxNameForConversation(conversationId, this.config.sandboxIdLength);
      const legacyName = legacySandboxNameForConversation(conversationHash);
      const owner =
        runtime.sandboxName === currentName ? conversationHash.slice(0, 63) : conversationHash;
      if (runtime.sandboxName !== currentName && runtime.sandboxName !== legacyName)
        throw new Error('OpenShell sandbox does not belong to this conversation');
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
      const previous = this.providerPolicyState.read(runtime.sandboxName);
      this.providerPolicyState.write(runtime.sandboxName, {
        automatic: previous?.automatic ?? [
          ...new Set(this.config.serviceProviders.filter((p) => SERVICE_PROVIDERS.has(p))),
        ],
        granted: [...new Set([...(previous?.granted ?? []), provider])],
      });
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
