import * as pty from 'node-pty';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openShellSshArgvProcessSpec } from './codex-app-server-client.js';
import type { TerminalBackend, TerminalRecord } from './terminal-service.js';

const execute = promisify(execFile);
export function safeTerminalEnvironment(base: NodeJS.ProcessEnv = process.env) {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ'])
    if (base[key]) env[key] = base[key]!;
  return { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
}
export function terminalProcessSpec(
  record: TerminalRecord,
  namespace: string,
  operation: 'attach' | 'resume' | 'check' | 'end',
) {
  if (!/^term-[0-9a-f-]{36}$/.test(record.id) || !/^mitzo-[a-zA-Z0-9_-]+$/.test(namespace))
    throw new Error('Invalid owned terminal selector');
  const args = [
    '-L',
    namespace,
    ...(operation === 'attach'
      ? ['new-session', '-A', '-s', record.id, '-c', record.cwd]
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
  if (record.kind === 'host') return { command: 'tmux', args, env: safeTerminalEnvironment() };
  if (!record.target?.runtime?.sandboxId) throw new Error('Sandbox terminal unavailable');
  const spec = openShellSshArgvProcessSpec(record.target.runtime, ['tmux', ...args]);
  return {
    ...spec,
    args: spec.args.map((value) =>
      value === '-T' && (operation === 'attach' || operation === 'resume') ? '-tt' : value,
    ),
    env: { ...spec.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  };
}
export class TmuxTerminalBackend implements TerminalBackend {
  constructor(private namespace: string) {}
  async start(
    record: TerminalRecord,
    resume: boolean,
    callbacks: { data(data: string): void; exit(): void },
  ) {
    if (resume) {
      const check = terminalProcessSpec(record, this.namespace, 'check');
      await execute(check.command, check.args, {
        env: check.env,
        timeout: 15_000,
        maxBuffer: 64 * 1024,
      });
    }
    const spec = terminalProcessSpec(record, this.namespace, resume ? 'resume' : 'attach');
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
      if (!detached) callbacks.exit();
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
    const spec = terminalProcessSpec(record, this.namespace, 'end');
    await execute(spec.command, spec.args, {
      env: spec.env,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    });
  }
}
