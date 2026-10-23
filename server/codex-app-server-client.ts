import {
  summarizeTurnStartFrame,
  type TurnInputWriteObserver,
} from './codex-turn-input-receipt.js';
import { nativeRoutingMessages, type NativeRoutingFailure } from './codex-native-diagnostics.js';
import {
  validateOpenShellCliEnvironment,
  type OpenShellCliEnvironment,
} from './openshell-cli-environment.js';
import { JIRA_API_ENDPOINT } from './connections-gateway.js';
import { applicationVersion } from './application-version.js';
import { spawn, spawnSync } from 'node:child_process';
import { z } from 'zod';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import type { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { dirname, isAbsolute, posix } from 'node:path';
import { AccountBindingSchema, type AccountBinding } from '@mitzo/protocol';
import { codexRuntimeOverrides } from './codex-runtime-policy.js';
import { FrozenHostCodexExecutable } from './frozen-host-codex-executable.js';
import { createLogger } from './logger.js';
import { tracer } from './tracing.js';
import { SpanStatusCode } from '@opentelemetry/api';

export const SUPPORTED_CODEX_CLI_VERSION = readFileSync(
  new URL('../docs/spikes/openshell-codex/runtime-codex-version', import.meta.url),
  'utf8',
).trim();
if (!/^\d+\.\d+\.\d+$/.test(SUPPORTED_CODEX_CLI_VERSION))
  throw new Error('Invalid Codex runtime version pin');

export function assertSupportedCodexCliVersion(output: string): void {
  const version = /^codex-cli\s+(\S+)\s*$/.exec(output)?.[1];
  if (version !== SUPPORTED_CODEX_CLI_VERSION)
    throw new Error(`Unsupported Codex CLI version; expected ${SUPPORTED_CODEX_CLI_VERSION}`);
}

function assertHostCodexRuntimeVersion(base: NodeJS.ProcessEnv, executable = 'codex'): void {
  const result = spawnSync(executable, ['--version'], {
    env: base,
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.error || result.status !== 0)
    throw new Error('Unable to verify the Codex CLI version');
  assertSupportedCodexCliVersion(result.stdout);
}

type JsonObject = Record<string, unknown>;
interface RpcProcess extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill(): unknown;
}
const hostToolFailureMessages = {
  invalid_tool_request:
    'Mitzo rejected an invalid tool request. Correct the request format before retrying.',
  tool_identity_mismatch:
    'Mitzo rejected this tool request because its thread or turn identity is stale. No tool was executed. Reconnect the conversation before retrying.',
  tool_unavailable:
    'This tool is unavailable in the current Mitzo conversation. Check the exposed tools and connection grants. Do not bypass the missing grant with shell networking.',
  tool_ledger_unavailable:
    'Mitzo could not record this tool request safely. No tool was executed. Inspect conversation recovery before retrying.',
} as const;

/** Server-authored classes only: never expose provider arguments or exception text. */
export class CodexHostToolRequestError extends Error {
  constructor(readonly category: keyof typeof hostToolFailureMessages) {
    super(hostToolFailureMessages[category]);
    this.name = 'CodexHostToolRequestError';
  }
}

export interface CodexServerRequestContext {
  readonly requestId: string | number;
  /** Trusted owner fences run synchronously immediately before the RPC reply. */
  readonly registerResponseFence?: (assertCurrent: () => void) => void;
}

export interface CodexLifecycleTransport {
  onNotification(method: string, params: JsonObject): void;
  onRequest(
    method: string,
    params: JsonObject,
    signal: AbortSignal,
    context?: CodexServerRequestContext,
  ): Promise<JsonObject>;
  onClose(error: Error): void;
}

/** The existing admission owner supplies an exclusively owned, new private home
 * and its credential/revocation fence. API account/read reports only an auth
 * mode, so it cannot replace that owner's proof of the selected billing account.
 */
export interface CodexApiBootstrapOptions {
  privateHome: string;
  executable: FrozenHostCodexExecutable;
  binding: AccountBinding;
  lifecycle: CodexLifecycleTransport;
  signal: AbortSignal;
  resolveKey(binding: Readonly<AccountBinding>, signal: AbortSignal): Promise<string>;
  assertCurrent(binding: Readonly<AccountBinding>): Promise<void>;
  base?: NodeJS.ProcessEnv;
}
interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export type CodexRequestErrorCategory =
  | NativeRoutingFailure
  | 'thread_state'
  | 'provider_transport'
  | 'context_limit'
  | 'rate_limit'
  | 'authentication'
  | 'invalid_request'
  | 'unknown';

function requestErrorCategory(message: string, method: string): CodexRequestErrorCategory {
  if (method === 'account/read' && Object.hasOwn(nativeRoutingMessages, message))
    return nativeRoutingMessages[message as keyof typeof nativeRoutingMessages];
  if (/(?:active turn|turn.*(?:running|in progress)|thread.*busy)/i.test(message))
    return 'thread_state';
  if (/(?:stream.*disconnect|connection.*(?:closed|lost)|transport)/i.test(message))
    return 'provider_transport';
  if (/context[_ -]length|too many tokens/i.test(message)) return 'context_limit';
  if (/(?:rate limit|too many requests|quota)/i.test(message)) return 'rate_limit';
  if (/(?:unauthenticated|unauthorized|forbidden|credential)/i.test(message))
    return 'authentication';
  if (/(?:invalid (?:params|request)|method not found)/i.test(message)) return 'invalid_request';
  return 'unknown';
}

/** Carries only a bounded failure class and numeric JSON-RPC code. The provider
 * message is inspected in-process but never retained in the Error or logs. */
export class CodexRequestError extends Error {
  constructor(
    readonly method: string,
    readonly category: CodexRequestErrorCategory,
    readonly code?: number,
  ) {
    super('Codex request failed; check configuration and retry');
    this.name = 'CodexRequestError';
  }
}

/** Local transport failures carry only a fixed reason, never a provider frame. */
export class CodexTransportError extends Error {
  constructor(
    readonly category: 'timeout' | 'connection' | 'protocol' | 'environment_pending',
    readonly diagnostic?: {
      reason:
        'frame_too_large' | 'invalid_json' | 'invalid_envelope' | 'notification_handler_failed';
      pendingRequestMethod?: string;
      frameBytes?: number;
      limitBytes?: number;
    },
  ) {
    super(
      {
        timeout: 'Codex request timed out; retry explicitly',
        connection: 'Codex connection closed',
        protocol: 'Invalid Codex protocol',
        environment_pending:
          'Approved integration environment is pending. No model turn was started.',
      }[category],
    );
    this.name = 'CodexTransportError';
  }
}

export interface OpenShellCodexOptions {
  sandboxName: string;
  workdir: string;
  appServerCommand?:
    | '/sandbox/run-mitzo-app-server'
    | '/sandbox/run-mitzo-subscription-app-server'
    | '/usr/local/bin/symposium-subscription-app-server';
  cli?: string;
  gateway?: string;
  workspace?: string;
  gatewayEndpoint?: string;
  gatewayInsecure?: boolean;
  cliEnvironment?: OpenShellCliEnvironment;
  /** Required service credentials derived only from verified public profiles.
   * A string requires that name; an alias group requires any one name in it. */
  requiredProviderEnvironment?: readonly (string | readonly string[])[];
  /** Non-secret, reviewed external-service context for managed sandbox tools. */
  connectionEnv?: { JIRA_URL: typeof JIRA_API_ENDPOINT; JIRA_EMAIL: string };
}

/** Build the development transport without forwarding host credentials to the
 * OpenShell CLI. Credential placeholders are attached to the sandbox by its
 * gateway providers; the custom provider deliberately uses inspected HTTPS.
 */
export function openShellSshProcessSpec(
  options: OpenShellCodexOptions,
  remoteCommand: string,
  base: NodeJS.ProcessEnv = process.env,
) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(options.sandboxName))
    throw new Error('Invalid OpenShell sandbox name');
  const workdir = posix.resolve(options.workdir);
  if (workdir === '/sandbox/workspaces' || !workdir.startsWith('/sandbox/workspaces/'))
    throw new Error('OpenShell workdir must be inside /sandbox/workspaces');
  const env: Record<string, string> = {};
  for (const key of [
    'PATH',
    'HOME',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'OPENSHELL_GATEWAY',
    'OPENSHELL_GATEWAY_ENDPOINT',
    'OPENSHELL_GATEWAY_INSECURE',
    'OPENSHELL_WORKSPACE',
  ]) {
    if (base[key]) env[key] = base[key]!;
  }
  const workspace = options.workspace || base.OPENSHELL_WORKSPACE || 'default';
  const gateway = options.gateway || base.OPENSHELL_GATEWAY || 'openshell';
  const cli = options.cli || 'openshell';
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(workspace))
    throw new Error('Invalid OpenShell workspace name');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(gateway))
    throw new Error('Invalid OpenShell gateway name');
  if ((cli !== 'openshell' && !isAbsolute(cli)) || !/^[A-Za-z0-9_./+-]+$/.test(cli))
    throw new Error('Invalid OpenShell CLI path');
  if (
    options.gatewayEndpoint &&
    !/^https?:\/\/[A-Za-z0-9.:[\]_-]+(?::\d+)?$/.test(options.gatewayEndpoint)
  )
    throw new Error('Invalid OpenShell gateway endpoint');
  if (!/^\/[A-Za-z0-9_./ -]+$/.test(remoteCommand))
    throw new Error('Invalid OpenShell remote command');
  return openShellSshProcessSpecTrusted(options, remoteCommand, base);
}

/** Builds a remote shell command from argv using POSIX single-quote escaping.
 * This is reserved for internal calls that need to carry opaque identity data;
 * unlike the legacy string API it accepts arbitrary non-NUL argument values. */
export function openShellSshArgvProcessSpec(
  options: OpenShellCodexOptions,
  argv: readonly string[],
  base: NodeJS.ProcessEnv = process.env,
) {
  if (!argv.length || argv.some((value) => !value || value.includes('\0')))
    throw new Error('Invalid OpenShell remote argv');
  return openShellSshProcessSpecTrusted(
    options,
    argv.map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(' '),
    base,
  );
}

function openShellSshProcessSpecTrusted(
  options: OpenShellCodexOptions,
  remoteCommand: string,
  base: NodeJS.ProcessEnv,
) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(options.sandboxName))
    throw new Error('Invalid OpenShell sandbox name');
  const workdir = posix.resolve(options.workdir);
  if (workdir === '/sandbox/workspaces' || !workdir.startsWith('/sandbox/workspaces/'))
    throw new Error('OpenShell workdir must be inside /sandbox/workspaces');
  const env: Record<string, string> = options.cliEnvironment
    ? validateOpenShellCliEnvironment(options.cliEnvironment)
    : {};
  for (const key of [
    'PATH',
    'HOME',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'OPENSHELL_GATEWAY',
    'OPENSHELL_GATEWAY_ENDPOINT',
    'OPENSHELL_GATEWAY_INSECURE',
    'OPENSHELL_WORKSPACE',
  ]) {
    if (!options.cliEnvironment && base[key]) env[key] = base[key]!;
  }
  const workspace = options.workspace || base.OPENSHELL_WORKSPACE || 'default';
  const gateway = options.gateway || base.OPENSHELL_GATEWAY || 'openshell';
  const cli = options.cli || 'openshell';
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(workspace))
    throw new Error('Invalid OpenShell workspace name');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(gateway))
    throw new Error('Invalid OpenShell gateway name');
  if ((cli !== 'openshell' && !isAbsolute(cli)) || !/^[A-Za-z0-9_./+-]+$/.test(cli))
    throw new Error('Invalid OpenShell CLI path');
  if (
    options.gatewayEndpoint &&
    !/^https?:\/\/[A-Za-z0-9.:[\]_-]+(?::\d+)?$/.test(options.gatewayEndpoint)
  )
    throw new Error('Invalid OpenShell gateway endpoint');
  const proxyCommand = options.gatewayEndpoint
    ? `${cli}${options.gatewayInsecure ? ' --gateway-insecure' : ''} ssh-proxy --server '${options.gatewayEndpoint}'`
    : `${cli} ssh-proxy --gateway-name ${gateway}`;
  return {
    command: 'ssh',
    args: [
      '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'PreferredAuthentications=none',
      '-o',
      'PubkeyAuthentication=no',
      '-o',
      'PasswordAuthentication=no',
      '-o',
      'KbdInteractiveAuthentication=no',
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'UserKnownHostsFile=/dev/null',
      '-o',
      'LogLevel=ERROR',
      '-o',
      `ProxyCommand=${proxyCommand} --name ${options.sandboxName} --workspace ${workspace}`,
      `sandbox@openshell-${options.sandboxName}.${workspace}`,
      connectionCommand(options, remoteCommand),
    ],
    env,
  };
}

function connectionCommand(options: OpenShellCodexOptions, command: string) {
  if (!options.connectionEnv) return command;
  const { JIRA_URL, JIRA_EMAIL } = options.connectionEnv;
  if (
    JIRA_URL !== JIRA_API_ENDPOINT ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/.test(JIRA_EMAIL)
  )
    throw new Error('Invalid managed Jira connection environment');
  // Email syntax permits shell metacharacters, so quote each generated assignment.
  const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
  return `env JIRA_URL=${quote(JIRA_URL)} JIRA_EMAIL=${quote(JIRA_EMAIL)} ${command}`;
}

export function openShellCodexProcessSpec(
  options: OpenShellCodexOptions,
  base: NodeJS.ProcessEnv = process.env,
) {
  if (options.appServerCommand === '/usr/local/bin/symposium-subscription-app-server')
    throw new Error('Native ChatGPT launch requires the isolated Symposium controller');
  const required = options.requiredProviderEnvironment ?? [];
  const groups = required.map((value) => (typeof value === 'string' ? [value] : value));
  if (
    groups.length > 64 ||
    groups.some(
      (group) =>
        !Array.isArray(group) ||
        !group.length ||
        group.length > 64 ||
        group.some((key) => typeof key !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(key)),
    ) ||
    new Set(groups.flat()).size > 64
  )
    throw new Error('Invalid required provider environment name');
  const command = options.appServerCommand || '/sandbox/run-mitzo-app-server';
  if (!required.length) return openShellSshProcessSpec(options, command, base);
  // This shell becomes the app-server. Its check never prints or copies values.
  const gate = groups
    .map(
      (group) =>
        [...new Set(group)].map((key) => `test -n "\${${key}:-}"`).join(' || ') + ' || exit 78',
    )
    .join('; ');
  return openShellSshArgvProcessSpec(
    options,
    ['/bin/sh', '-c', `${gate}; exec '${command}'`],
    base,
  );
}

export function terminateOpenShellProcess(
  child: { pid?: number; kill(): unknown },
  killGroup: (pid: number, signal: NodeJS.Signals) => unknown = process.kill,
) {
  if (child.pid)
    try {
      killGroup(-child.pid, 'SIGTERM');
      return true;
    } catch {
      /* Fall back if the process exited before its group was established. */
    }
  return child.kill();
}

/** Explicit login storage; never pass API billing or arbitrary server secrets to Codex. */
export function codexEnvironment(
  credentialRef: string,
  base: NodeJS.ProcessEnv,
): Record<string, string> {
  if (!isAbsolute(credentialRef)) throw new Error('Codex login directory must be absolute');
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']) {
    if (base[key]) env[key] = base[key];
  }
  return { ...env, CODEX_HOME: credentialRef };
}

/** Private stdio transport. It never retries a request with an uncertain outcome. */
export class CodexAppServerClient {
  private sequence = 0;
  private readonly hostAbort = new AbortController();
  // Keep consumed IDs for this transport lifetime: resolved work is never replayed.
  private readonly hostRequests = new Set<string | number>();
  private readonly activeHostRequests = new Map<
    string | number,
    { abort: AbortController; threadId: unknown }
  >();
  private readonly lifecycle?: CodexLifecycleTransport;
  private pending = new Map<number, Pending>();
  private buffer = Buffer.alloc(0);
  private bufferedBytes = 0;
  private closed = false;
  private ready = false;
  private initializing?: Promise<void>;
  private initializationFrame?: JsonObject;
  private environmentLaunch?: { create: () => RpcProcess };
  private environmentAttempts = 0;
  private environmentRetryTimer?: ReturnType<typeof setTimeout>;
  private waitingForEnvironment = false;
  private retiredChildren = new WeakSet<RpcProcess>();
  private readonly maxFrameBytes: number;
  private readonly timeoutMs: number;
  private readonly loginOnly: boolean;
  private readonly observeTurnStartWrite?: TurnInputWriteObserver;

  constructor(
    private child: RpcProcess,
    options: {
      timeoutMs?: number;
      maxFrameBytes?: number;
      lifecycle?: CodexLifecycleTransport;
      loginOnly?: boolean;
      /** Trusted same-command fresh process launch, before any model turn. */
      environmentLaunch?: { create: () => RpcProcess };
      /** Trusted opt-in metadata observer; prepared persistence must succeed before write. */
      observeTurnStartWrite?: TurnInputWriteObserver;
    } = {},
  ) {
    this.lifecycle = options.lifecycle;
    this.observeTurnStartWrite = options.observeTurnStartWrite;
    this.loginOnly = options.loginOnly ?? false;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxFrameBytes = options.maxFrameBytes ?? 4 * 1024 * 1024;
    this.environmentLaunch = options.environmentLaunch;
    this.bindChild(child);
  }

  private bindChild(child: RpcProcess) {
    const current = () => child === this.child && !this.retiredChildren.has(child);
    child.stdout.on('data', (chunk: Buffer) => {
      if (current()) this.receive(chunk);
    });
    // Provider diagnostics may contain private paths or credential material.
    child.stderr.resume();
    child.on('error', () => {
      if (current()) this.close();
    });
    child.on('exit', (code: number | null) => {
      if (!current() || this.closed) return;
      if (!this.ready && code === 78 && this.environmentLaunch) {
        this.waitingForEnvironment = true;
        if (this.environmentAttempts >= 2) {
          this.close(new CodexTransportError('environment_pending'));
          return;
        }
        this.environmentAttempts++;
        this.retiredChildren.add(child);
        child.kill();
        this.buffer = Buffer.alloc(0);
        this.bufferedBytes = 0;
        // The pinned supervisor polls provider configuration every ten seconds.
        this.environmentRetryTimer = setTimeout(() => {
          this.environmentRetryTimer = undefined;
          if (this.closed) return;
          try {
            this.child = this.environmentLaunch!.create();
            this.bindChild(this.child);
            if (this.initializationFrame) this.write(this.initializationFrame);
          } catch {
            this.close(new CodexTransportError('environment_pending'));
          }
        }, 10_000);
        return;
      }
      this.close();
    });
    child.stdin.on('error', () => {
      if (current()) this.close();
    });
    child.stdout.on('error', () => {
      if (current()) this.close();
    });
    child.stderr.on('error', () => {
      if (current()) this.close();
    });
  }

  static launch(
    credentialRef: string,
    base: NodeJS.ProcessEnv = process.env,
    lifecycle?: CodexLifecycleTransport,
  ) {
    return this.launchHost(credentialRef, base, lifecycle, false);
  }

  /** Metadata only, using the native executable selected by the owning runtime.
   * No lifecycle means this transport cannot start threads or model turns.
   */
  static launchPreflight(
    credentialRef: string,
    executablePath: string,
    base: NodeJS.ProcessEnv = process.env,
  ) {
    if (!isAbsolute(executablePath)) throw new Error('Codex executable must be absolute');
    return this.launchHost(
      credentialRef,
      base,
      undefined,
      false,
      undefined,
      'chatgpt',
      executablePath,
    );
  }

  /** Only the private bootstrap owner supplies this home, after durable effect
   * admission. File-only custody prevents a shared keychain login from replacing
   * the frozen account. The original configured profile remains routing identity.
   */
  static launchIsolated(
    privateHome: string,
    base: NodeJS.ProcessEnv = process.env,
    lifecycle?: CodexLifecycleTransport,
    executable?: FrozenHostCodexExecutable,
  ) {
    if (!(executable instanceof FrozenHostCodexExecutable))
      throw new Error('Host Codex runtime unavailable');
    executable.assertLaunchCurrent();
    return this.launchHost(privateHome, base, lifecycle, true, executable);
  }
  /** The native owner has revalidated its retained API auth file and key controller. */
  static launchIsolatedApiResume(
    privateHome: string,
    base: NodeJS.ProcessEnv = process.env,
    lifecycle?: CodexLifecycleTransport,
    executable?: FrozenHostCodexExecutable,
  ) {
    if (
      !(executable instanceof FrozenHostCodexExecutable) ||
      dirname(executable.path) !== privateHome
    )
      throw new Error('Host Codex runtime unavailable');
    executable.assertLaunchCurrent();
    return this.launchHost(privateHome, base, lifecycle, true, executable, 'api');
  }

  /** New-account bootstrap only. Login is private to this operation; the returned
   * transport cannot log in again or switch billing through its public RPC API.
   * The caller retains workspace/command authority and owns subsequent custody,
   * credential renewal and cold continuation. This does not enable a chat route.
   */
  static async launchIsolatedApi(options: CodexApiBootstrapOptions): Promise<{
    client: CodexAppServerClient;
    binding: Readonly<AccountBinding>;
  }> {
    let client: CodexAppServerClient | undefined;
    const { privateHome, executable, signal, lifecycle } = options;
    const assertCurrent = options.assertCurrent.bind(options);
    const resolveKey = options.resolveKey.bind(options);
    const base = { ...(options.base ?? process.env) };
    const onAbort = () => client?.close();
    try {
      const binding = Object.freeze(AccountBindingSchema.parse(options.binding));
      if (binding.provider !== 'openai') throw new Error('API account required');
      signal.throwIfAborted();
      const home = lstatSync(privateHome);
      const assertNewHome = () => {
        const current = lstatSync(privateHome);
        if (
          !isAbsolute(privateHome) ||
          realpathSync(privateHome) !== privateHome ||
          !current.isDirectory() ||
          current.dev !== home.dev ||
          current.ino !== home.ino ||
          (current.mode & 0o077) !== 0 ||
          current.uid !== process.getuid?.() ||
          !(executable instanceof FrozenHostCodexExecutable) ||
          dirname(executable.path) !== privateHome ||
          lstatSync(`${privateHome}/auth.json`, { throwIfNoEntry: false }) ||
          lstatSync(`${privateHome}/config.toml`, { throwIfNoEntry: false })
        )
          throw new Error('New private API home required');
      };
      assertNewHome();
      await assertCurrent(binding);
      signal.throwIfAborted();
      const key = await resolveKey(binding, signal);
      signal.throwIfAborted();
      if (typeof key !== 'string' || !key.trim()) throw new Error('API credential required');
      await assertCurrent(binding);
      signal.throwIfAborted();
      executable.assertLaunchCurrent();
      assertNewHome();
      client = this.launchHost(privateHome, base, lifecycle, true, executable, 'api');
      signal.addEventListener('abort', onAbort, { once: true });
      signal.throwIfAborted();
      await client.initialize();
      await assertCurrent(binding);
      signal.throwIfAborted();
      assertNewHome();
      const login = await client.sendRequest('account/login/start', {
        type: 'apiKey',
        apiKey: key,
      });
      signal.throwIfAborted();
      z.object({ type: z.literal('apiKey') }).parse(login);
      const observed = await client.request('account/read', { refreshToken: false });
      z.object({
        account: z.object({ type: z.literal('apiKey') }),
        requiresOpenaiAuth: z.literal(true),
      }).parse(observed);
      await assertCurrent(binding);
      signal.throwIfAborted();
      return { client, binding };
    } catch {
      client?.close();
      // Neither credential-provider errors nor login frames are public diagnostics.
      throw new Error('API Codex authentication unavailable');
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  private static launchHost(
    credentialRef: string,
    base: NodeJS.ProcessEnv,
    lifecycle: CodexLifecycleTransport | undefined,
    isolated: boolean,
    executable?: FrozenHostCodexExecutable,
    authentication: 'chatgpt' | 'api' = 'chatgpt',
    preflightExecutable?: string,
  ) {
    const env = codexEnvironment(credentialRef, base);
    const executablePath = executable?.path ?? preflightExecutable;
    assertHostCodexRuntimeVersion(isolated ? env : base, executablePath);
    executable?.assertCurrent();
    return new CodexAppServerClient(
      spawn(
        executablePath ?? 'codex',
        [
          'app-server',
          '--stdio',
          '-c',
          `forced_login_method="${authentication}"`,
          '-c',
          'model_provider="openai"',
          ...(authentication === 'api'
            ? ['-c', 'openai_base_url="https://api.openai.com/v1"']
            : []),
          ...(isolated ? ['-c', 'cli_auth_credentials_store="file"'] : []),
          ...(lifecycle || authentication === 'api'
            ? Object.entries(codexRuntimeOverrides({})).flatMap(([key, value]) => [
                '-c',
                `${key}=${JSON.stringify(value)}`,
              ])
            : []),
        ],
        { env, stdio: ['pipe', 'pipe', 'pipe'] },
      ),
      { lifecycle },
    );
  }

  static launchOpenShell(
    options: OpenShellCodexOptions,
    base: NodeJS.ProcessEnv = process.env,
    lifecycle?: CodexLifecycleTransport,
  ) {
    const spec = openShellCodexProcessSpec(options, base);
    const create = () => {
      const child = spawn(spec.command, spec.args, {
        detached: true,
        env: spec.env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const killChild = child.kill.bind(child);
      child.kill = (() =>
        terminateOpenShellProcess({ pid: child.pid, kill: killChild })) as typeof child.kill;
      return child;
    };
    return new CodexAppServerClient(create(), {
      lifecycle,
      ...(options.requiredProviderEnvironment?.length ? { environmentLaunch: { create } } : {}),
    });
  }

  initialize(): Promise<void> {
    this.initializing ??= this.sendRequest('initialize', {
      clientInfo: { name: 'mitzo', version: applicationVersion },
      capabilities: { experimentalApi: true },
    }).then(() => {
      this.write({ method: 'initialized', params: {} });
      this.ready = true;
      this.waitingForEnvironment = false;
      this.initializationFrame = undefined;
    });
    return this.initializing;
  }

  request(method: string, params: JsonObject): Promise<unknown> {
    if (this.closed) return Promise.reject(new CodexTransportError('connection'));
    if (!this.ready) return Promise.reject(new Error('Codex connection not initialized'));
    const allowed = this.loginOnly
      ? ['account/read', 'account/login/start', 'account/login/cancel']
      : ['account/read', 'model/list'];
    if (this.lifecycle && !this.loginOnly)
      allowed.push(
        'config/read',
        'thread/start',
        'thread/resume',
        'thread/fork',
        'thread/read',
        'thread/turns/list',
        'turn/start',
        'turn/interrupt',
      );
    if (!allowed.includes(method))
      return Promise.reject(
        new Error(
          this.lifecycle
            ? 'Codex method not supported'
            : 'Codex connection supports preflight only',
        ),
      );
    return this.sendRequest(method, params);
  }

  close(error: Error = new CodexTransportError('connection')) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.environmentRetryTimer);
    this.environmentRetryTimer = undefined;
    this.ready = false;
    this.buffer = Buffer.alloc(0);
    this.bufferedBytes = 0;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.hostAbort.abort();
    this.hostRequests.clear();
    this.activeHostRequests.clear();
    this.child.kill();
    this.lifecycle?.onClose(error);
  }

  private sendRequest(method: string, params: JsonObject): Promise<unknown> {
    if (this.closed) return Promise.reject(new CodexTransportError('connection'));
    const id = ++this.sequence;
    // initialize and request's allowlist supply bounded method names. Frames,
    // response bodies and upstream exception text never enter telemetry.
    const span = tracer.startSpan('codex.rpc', {
      attributes: {
        'rpc.system': 'jsonrpc',
        'rpc.method': method,
        'rpc.timeout_ms': this.timeoutMs,
      },
    });
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.close(
            new CodexTransportError(this.waitingForEnvironment ? 'environment_pending' : 'timeout'),
          ),
        this.timeoutMs,
      );
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        const frame = { id, method, params };
        if (method === 'initialize') this.initializationFrame = frame;
        this.write(frame);
      } catch {
        this.close();
      }
    }).then(
      (result) => {
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
        return result;
      },
      (error: unknown) => {
        span.setAttribute(
          'rpc.failure.category',
          error instanceof CodexTransportError || error instanceof CodexRequestError
            ? error.category
            : 'unknown',
        );
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
        throw error;
      },
    );
  }

  private write(value: JsonObject) {
    if (this.closed) throw new CodexTransportError('connection');
    const frame = JSON.stringify(value) + '\n';
    if (!this.observeTurnStartWrite || value.method !== 'turn/start') {
      this.child.stdin.write(frame);
      return;
    }
    const metadata = summarizeTurnStartFrame(frame);
    const observe = this.observeTurnStartWrite;
    observe({ ...metadata, boundary: 'prepared' });
    let queued = false;
    let completed = false;
    let failed = false;
    const finish = () => {
      if (!queued || !completed) return;
      try {
        observe({ ...metadata, boundary: failed ? 'write_failed' : 'write_completed' });
      } catch {
        this.close();
      }
    };
    try {
      this.child.stdin.write(frame, (error) => {
        completed = true;
        failed = Boolean(error);
        finish();
        if (error) this.close();
      });
    } catch {
      observe({ ...metadata, boundary: 'write_failed' });
      throw new CodexTransportError('connection');
    }
    observe({ ...metadata, boundary: 'write_queued' });
    queued = true;
    finish();
  }

  private handleHostRequest(id: string | number, method: string, params: JsonObject) {
    if (!this.lifecycle) {
      try {
        this.write({ id, error: { code: -32601, message: 'Unsupported Codex request' } });
      } catch {
        this.close();
      }
      return;
    }
    // Repeated requests, including settled requests, cannot repeat a side effect.
    if (this.hostRequests.has(id)) {
      try {
        this.write({ id, error: { code: -32600, message: 'Duplicate Codex request' } });
      } catch {
        this.close();
      }
      return;
    }
    this.hostRequests.add(id);
    const abort = new AbortController();
    const signal = AbortSignal.any([this.hostAbort.signal, abort.signal]);
    this.activeHostRequests.set(id, { abort, threadId: params.threadId });
    const responseFences: Array<() => void> = [];
    const context: CodexServerRequestContext = Object.freeze({
      requestId: id,
      registerResponseFence: (assertCurrent: () => void) => responseFences.push(assertCurrent),
    });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return this.lifecycle!.onRequest(method, params, signal, context);
      })
      .then(
        (result) => {
          if (this.closed || signal.aborted) return;
          for (const assertCurrent of responseFences) {
            const result: unknown = assertCurrent();
            if (result !== undefined) {
              void Promise.resolve(result).catch(() => {});
              throw new CodexTransportError('connection');
            }
          }
          if (!this.closed && !signal.aborted) this.write({ id, result });
        },
        (error: unknown) => {
          if (this.closed || signal.aborted) return;
          if (method === 'item/tool/call') {
            const known = error instanceof CodexHostToolRequestError;
            createLogger('codex-app-server-client').warn('Codex host tool request rejected', {
              failureClass: known ? error.category : 'tool_dispatch_failed',
            });
            // JSON-RPC errors are collapsed by Codex into "dynamic tool request
            // failed". A failed tool result preserves our bounded diagnostic.
            this.write({
              id,
              result: {
                success: false,
                contentItems: [
                  {
                    type: 'inputText',
                    text: known
                      ? hostToolFailureMessages[error.category]
                      : 'Mitzo could not dispatch this tool request. No external action was confirmed. Inspect current state before retrying.',
                  },
                ],
              },
            });
          } else {
            this.write({ id, error: { code: -32603, message: 'Host request failed' } });
          }
        },
      )
      .catch(() => this.close())
      .finally(() => this.activeHostRequests.delete(id));
  }

  private receive(chunk: Buffer) {
    let offset = 0;
    while (!this.closed && offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      const frameBytes = this.bufferedBytes + part.length;
      if (frameBytes > this.maxFrameBytes) {
        this.frameFailure('protocol', 'frame_too_large', frameBytes);
        return;
      }
      let frame = part;
      if (this.bufferedBytes || newline === -1) {
        // Grow geometrically, bounded by one frame. Repeated concatenation of
        // a fragmented response copies the entire prefix on every chunk.
        if (this.buffer.length < frameBytes) {
          const capacity = Math.min(
            this.maxFrameBytes,
            Math.max(4096, this.buffer.length * 2, frameBytes),
          );
          const next = Buffer.allocUnsafe(capacity);
          this.buffer.copy(next, 0, 0, this.bufferedBytes);
          this.buffer = next;
        }
        part.copy(this.buffer, this.bufferedBytes);
        this.bufferedBytes = frameBytes;
        if (newline === -1) return;
        frame = this.buffer.subarray(0, frameBytes);
        this.buffer = Buffer.alloc(0);
        this.bufferedBytes = 0;
      }
      offset = end + 1;
      this.receiveFrame(frame);
    }
  }

  private frameFailure(
    category: 'protocol' | 'connection',
    reason: NonNullable<CodexTransportError['diagnostic']>['reason'],
    frameBytes?: number,
  ) {
    const pending = this.pending.size === 1 ? this.pending.values().next().value : undefined;
    this.close(
      new CodexTransportError(category, {
        reason,
        ...(pending ? { pendingRequestMethod: pending.method } : {}),
        ...(reason === 'frame_too_large' ? { frameBytes, limitBytes: this.maxFrameBytes } : {}),
      }),
    );
  }

  private receiveFrame(bytes: Buffer) {
    let frame: unknown;
    try {
      frame = JSON.parse(bytes.toString('utf8'));
    } catch {
      this.frameFailure('protocol', 'invalid_json');
      return;
    }
    const invalid = () => this.frameFailure('protocol', 'invalid_envelope');
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return invalid();
    const message = frame as JsonObject;
    if (typeof message.method === 'string') {
      const params = message.params ?? {};
      if (!params || typeof params !== 'object' || Array.isArray(params)) return invalid();
      if (message.id === undefined) {
        if (message.method === 'serverRequest/resolved') {
          const resolved = params as JsonObject;
          if (typeof resolved.requestId === 'string' || typeof resolved.requestId === 'number') {
            const request = this.activeHostRequests.get(resolved.requestId);
            if (request && request.threadId === resolved.threadId) request.abort.abort();
          }
        }
        try {
          this.lifecycle?.onNotification(message.method, params as JsonObject);
        } catch {
          this.frameFailure('connection', 'notification_handler_failed');
        }
      } else if (typeof message.id === 'string' || typeof message.id === 'number') {
        this.handleHostRequest(message.id, message.method, params as JsonObject);
      } else invalid();
      return;
    }
    if (typeof message.id !== 'number') return invalid();
    const request = this.pending.get(message.id);
    if (!request) return;
    if (!message.error && !('result' in message)) return invalid();
    this.pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) {
      const parsed = z
        .object({ code: z.number().int().optional(), message: z.string().optional() })
        .passthrough()
        .safeParse(message.error);
      request.reject(
        new CodexRequestError(
          request.method,
          requestErrorCategory(parsed.success ? (parsed.data.message ?? '') : '', request.method),
          parsed.success ? parsed.data.code : undefined,
        ),
      );
    } else request.resolve(message.result);
  }
}
