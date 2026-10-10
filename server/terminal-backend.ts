import { TerminalSessionMissing } from './terminal-errors.js';
import * as pty from 'node-pty';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openShellSshArgvProcessSpec } from './codex-app-server-client.js';
import { TerminalSshApi } from './terminal-ssh-api.js';
import type { OpenShellRuntime } from './openshell-runtime.js';
import type { TerminalBackend, TerminalRecord } from './terminal-service.js';

const execute = promisify(execFile);
export function safeTerminalEnvironment(base: NodeJS.ProcessEnv = process.env) {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ'])
    if (base[key]) env[key] = base[key]!;
  return { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
}
interface TerminalSshGrant {
  sandboxId: string;
  proxyUrl: string;
  token: string;
}
export function terminalProcessSpec(
  record: TerminalRecord,
  namespace: string,
  operation: 'attach' | 'resume' | 'check' | 'end',
  grant?: TerminalSshGrant,
  hostEnvironment: NodeJS.ProcessEnv = process.env,
) {
  if (!/^term-[0-9a-f-]{36}$/.test(record.id) || !/^mitzo-[a-zA-Z0-9_-]+$/.test(namespace))
    throw new Error('Invalid owned terminal selector');
  const args = [
    '-L',
    namespace,
    '-f',
    '/dev/null',
    ...(operation === 'attach'
      ? [
          'new-session',
          '-A',
          '-s',
          record.id,
          '-c',
          record.cwd,
          ';',
          'set-option',
          '-t',
          record.id,
          'status',
          'off',
        ]
      : [
          operation === 'resume'
            ? 'attach-session'
            : operation === 'check'
              ? 'has-session'
              : 'kill-session',
          '-t',
          record.id,
        ]),
  ];
  if (record.kind === 'host')
    return { command: 'tmux', args, env: safeTerminalEnvironment(hostEnvironment) };
  if (!record.target?.runtime?.sandboxId) throw new Error('Sandbox terminal unavailable');
  const runtime = record.target.runtime;
  if (
    !grant ||
    grant.sandboxId !== runtime.sandboxId ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(grant.sandboxId) ||
    !/^[A-Za-z0-9._~+/=-]{1,4096}$/.test(grant.token)
  )
    throw Error('Pinned terminal SSH grant unavailable');
  const proxy = new URL(grant.proxyUrl);
  if (
    proxy.protocol !== 'https:' ||
    proxy.username ||
    proxy.password ||
    proxy.search ||
    proxy.hash ||
    proxy.pathname !== '/proxy/connect'
  )
    throw Error('Pinned terminal SSH gateway unavailable');
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const spec = openShellSshArgvProcessSpec(runtime, ['tmux', ...args]);
  const proxyCommand = `ProxyCommand=${quote(runtime.cli || 'openshell')} ssh-proxy --gateway ${quote(grant.proxyUrl)} --sandbox-id ${quote(grant.sandboxId)} --token ${quote(grant.token)} --workspace ${quote(runtime.workspace || 'default')}`;
  spec.args = spec.args.map((value) => (value.startsWith('ProxyCommand=') ? proxyCommand : value));
  return {
    ...spec,
    args: spec.args.map((value) =>
      value === '-T' && (operation === 'attach' || operation === 'resume') ? '-tt' : value,
    ),
    env: { ...spec.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  };
}
export class TmuxTerminalBackend implements TerminalBackend {
  private gateways = new Map<string, TerminalSshApi>();
  constructor(
    private namespace: string,
    private hostEnvironment: NodeJS.ProcessEnv = process.env,
  ) {}
  private async spec(record: TerminalRecord, operation: 'attach' | 'resume' | 'check' | 'end') {
    if (record.kind === 'host')
      return terminalProcessSpec(
        record,
        this.namespace,
        operation,
        undefined,
        this.hostEnvironment,
      );
    const runtime = record.target?.runtime as
      (OpenShellRuntime & { sandboxId: string }) | undefined;
    if (!runtime?.sandboxId) throw Error('Sandbox terminal unavailable');
    const home = runtime.cliEnvironment?.HOME;
    if (!home) throw Error('Private terminal gateway environment unavailable');
    const key = JSON.stringify([home, runtime.gateway, runtime.gatewayEndpoint, runtime.workspace]);
    let gateway = this.gateways.get(key);
    if (!gateway) {
      gateway = new TerminalSshApi({
        home,
        gateway: runtime.gateway || 'openshell',
        endpoint: runtime.gatewayEndpoint,
        workspace: runtime.workspace || 'default',
        protocol: 'openshell-v1',
      });
      this.gateways.set(key, gateway);
    }
    const grant = await gateway.createTerminalSsh(runtime.sandboxId, AbortSignal.timeout(15000));
    return terminalProcessSpec(record, this.namespace, operation, grant);
  }
  private async checkSession(record: TerminalRecord) {
    const check = await this.spec(record, 'check');
    try {
      await execute(check.command, check.args, {
        env: check.env,
        timeout: 15000,
        maxBuffer: 64 * 1024,
      });
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 1 &&
        'stderr' in error &&
        typeof error.stderr === 'string'
      ) {
        const detail = error.stderr.trim();
        if (
          detail.startsWith('no server running on ') ||
          detail === `can't find session: ${record.id}`
        )
          throw new TerminalSessionMissing();
      }
      // Process errors include SSH proxy arguments and their short-lived grant token.
      // eslint-disable-next-line preserve-caught-error
      throw Error('Terminal transport unavailable');
    }
  }
  async start(
    record: TerminalRecord,
    resume: boolean,
    callbacks: { data(data: string): void; exit(reason?: 'disconnected'): void },
  ) {
    if (resume) await this.checkSession(record);
    const spec = await this.spec(record, resume ? 'resume' : 'attach');
    const process = pty.spawn(spec.command, spec.args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: record.kind === 'host' ? record.cwd : undefined,
      env: spec.env,
    });
    let detached = false;
    const data = process.onData((value) => {
      if (!detached) callbacks.data(value);
    });
    const exit = process.onExit(() => {
      if (detached) return;
      void this.checkSession(record).then(
        () => {
          if (!detached) callbacks.exit('disconnected');
        },
        (error) => {
          if (!detached)
            callbacks.exit(error instanceof TerminalSessionMissing ? undefined : 'disconnected');
        },
      );
    });
    return {
      write: (value: string) => process.write(value),
      resize: (cols: number, rows: number) => process.resize(cols, rows),
      detach: () => {
        detached = true;
        data.dispose();
        exit.dispose();
        try {
          process.kill();
        } catch {
          /* The tmux client may already have exited. */
        }
      },
    };
  }
  async end(record: TerminalRecord) {
    const spec = await this.spec(record, 'end');
    await execute(spec.command, spec.args, {
      env: spec.env,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    });
  }
}
