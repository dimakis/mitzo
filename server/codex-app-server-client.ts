import { applicationVersion } from './application-version.js';
import { spawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { isAbsolute, posix } from 'node:path';
import { codexRuntimeOverrides } from './codex-runtime-policy.js';

type JsonObject = Record<string, unknown>;
interface RpcProcess extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill(): unknown;
}
export interface CodexLifecycleTransport {
  onNotification(method: string, params: JsonObject): void;
  onRequest(method: string, params: JsonObject, signal: AbortSignal): Promise<JsonObject>;
  onClose(error: Error): void;
}
interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface OpenShellCodexOptions {
  sandboxName: string;
  workdir: string;
  appServerCommand?: '/sandbox/run-mitzo-app-server' | '/sandbox/run-mitzo-subscription-app-server';
  cli?: string;
  gateway?: string;
  workspace?: string;
  gatewayEndpoint?: string;
  gatewayInsecure?: boolean;
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
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(workspace))
    throw new Error('Invalid OpenShell workspace name');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(gateway))
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
      remoteCommand,
    ],
    env,
  };
}

export function openShellCodexProcessSpec(
  options: OpenShellCodexOptions,
  base: NodeJS.ProcessEnv = process.env,
) {
  return openShellSshProcessSpec(
    options,
    options.appServerCommand || '/sandbox/run-mitzo-app-server',
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
  private readonly hostRequests = new Set<string | number>();
  private readonly lifecycle?: CodexLifecycleTransport;
  private pending = new Map<number, Pending>();
  private buffer = Buffer.alloc(0);
  private closed = false;
  private ready = false;
  private initializing?: Promise<void>;
  private readonly maxFrameBytes: number;
  private readonly timeoutMs: number;

  constructor(
    private child: RpcProcess,
    options: {
      timeoutMs?: number;
      maxFrameBytes?: number;
      lifecycle?: CodexLifecycleTransport;
    } = {},
  ) {
    this.lifecycle = options.lifecycle;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxFrameBytes = options.maxFrameBytes ?? 4 * 1024 * 1024;
    child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    // Provider diagnostics may contain private paths or credential material.
    child.stderr.resume();
    child.on('error', () => this.close());
    child.on('exit', () => this.close());
    child.stdin.on('error', () => this.close());
    child.stdout.on('error', () => this.close());
    child.stderr.on('error', () => this.close());
  }

  static launch(
    credentialRef: string,
    base: NodeJS.ProcessEnv = process.env,
    lifecycle?: CodexLifecycleTransport,
  ) {
    return new CodexAppServerClient(
      spawn(
        'codex',
        [
          'app-server',
          '--stdio',
          '-c',
          'forced_login_method="chatgpt"',
          '-c',
          'model_provider="openai"',
          ...(lifecycle
            ? Object.entries(codexRuntimeOverrides({})).flatMap(([key, value]) => [
                '-c',
                `${key}=${JSON.stringify(value)}`,
              ])
            : []),
        ],
        { env: codexEnvironment(credentialRef, base), stdio: ['pipe', 'pipe', 'pipe'] },
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
    const child = spawn(spec.command, spec.args, {
      detached: true,
      env: spec.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const killChild = child.kill.bind(child);
    // ssh starts the OpenShell ProxyCommand as a child. Kill the process group so
    // closing or interrupting a Mitzo task cannot leave the proxy holding stdio.
    child.kill = (() => {
      return terminateOpenShellProcess({ pid: child.pid, kill: killChild });
    }) as typeof child.kill;
    return new CodexAppServerClient(child, { lifecycle });
  }

  initialize(): Promise<void> {
    this.initializing ??= this.sendRequest('initialize', {
      clientInfo: { name: 'mitzo', version: applicationVersion },
      capabilities: { experimentalApi: true },
    }).then(() => {
      this.write({ method: 'initialized', params: {} });
      this.ready = true;
    });
    return this.initializing;
  }

  request(method: string, params: JsonObject): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Codex connection closed'));
    if (!this.ready) return Promise.reject(new Error('Codex connection not initialized'));
    const allowed = ['account/read', 'model/list'];
    if (this.lifecycle)
      allowed.push(
        'config/read',
        'thread/start',
        'thread/resume',
        'thread/read',
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

  close(error = new Error('Codex connection closed')) {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.buffer = Buffer.alloc(0);
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.hostAbort.abort();
    this.hostRequests.clear();
    this.child.kill();
    this.lifecycle?.onClose(error);
  }

  private sendRequest(method: string, params: JsonObject): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Codex connection closed'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.close(new Error('Codex request timed out; retry explicitly')),
        this.timeoutMs,
      );
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch {
        this.close();
      }
    });
  }

  private write(value: JsonObject) {
    if (this.closed) throw new Error('Codex connection closed');
    this.child.stdin.write(JSON.stringify(value) + '\n');
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
    // Repeated in-flight requests must not execute a side effect twice.
    if (this.hostRequests.has(id)) {
      try {
        this.write({ id, error: { code: -32600, message: 'Duplicate Codex request' } });
      } catch {
        this.close();
      }
      return;
    }
    this.hostRequests.add(id);
    Promise.resolve()
      .then(() => {
        this.hostAbort.signal.throwIfAborted();
        return this.lifecycle!.onRequest(method, params, this.hostAbort.signal);
      })
      .then(
        (result) => {
          if (!this.closed) this.write({ id, result });
        },
        () => {
          if (!this.closed)
            this.write({ id, error: { code: -32603, message: 'Host request failed' } });
        },
      )
      .catch(() => this.close())
      .finally(() => this.hostRequests.delete(id));
  }

  private receive(chunk: Buffer) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      let newline: number;
      while ((newline = this.buffer.indexOf(10)) !== -1) {
        if (newline > this.maxFrameBytes) throw new Error();
        const frame: unknown = JSON.parse(this.buffer.subarray(0, newline).toString('utf8'));
        this.buffer = this.buffer.subarray(newline + 1);
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error();
        const message = frame as JsonObject;
        if (typeof message.method === 'string') {
          const params = message.params ?? {};
          if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error();
          if (message.id === undefined) {
            this.lifecycle?.onNotification(message.method, params as JsonObject);
          } else if (typeof message.id === 'string' || typeof message.id === 'number') {
            this.handleHostRequest(message.id, message.method, params as JsonObject);
          } else throw new Error();
          continue;
        }
        if (typeof message.id !== 'number') throw new Error();
        const request = this.pending.get(message.id);
        if (!request) continue;
        this.pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error)
          request.reject(new Error('Codex request failed; check configuration and retry'));
        else if ('result' in message) request.resolve(message.result);
        else {
          request.reject(new Error('Invalid Codex protocol'));
          throw new Error();
        }
      }
      if (this.buffer.length > this.maxFrameBytes) throw new Error();
    } catch {
      this.close(new Error('Invalid Codex protocol'));
    }
  }
}
