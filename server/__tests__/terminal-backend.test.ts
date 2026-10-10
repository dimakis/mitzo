import { describe, expect, it } from 'vitest';
import { terminalProcessSpec, safeTerminalEnvironment } from '../terminal-backend.js';
import type { TerminalRecord } from '../terminal-service.js';
const record: TerminalRecord = {
  id: 'term-01234567-1234-1234-1234-123456789abc',
  owner: 'operator',
  identity: 'host',
  kind: 'host',
  label: 'Your Mac',
  cwd: '/home/operator',
  state: 'running',
  createdAt: 1,
  target: { kind: 'host', identity: 'host', label: 'Your Mac', cwd: '/home/operator' },
};
describe('terminal process boundary', () => {
  it('creates only the owned tmux session and never invokes a shell interpreter', () => {
    const spec = terminalProcessSpec(record, 'mitzo-test', 'attach');
    expect(spec.command).toBe('tmux');
    expect(spec.args).toEqual([
      '-L',
      'mitzo-test',
      '-f',
      '/dev/null',
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
    ]);
  });
  it('does not forward server credentials or administrative configuration', () => {
    expect(
      safeTerminalEnvironment({
        PATH: '/bin',
        HOME: '/home/operator',
        OPENAI_API_KEY: 'secret',
        GH_TOKEN: 'secret',
        AUTH_SECRET: 'secret',
      }),
    ).toEqual({
      PATH: '/bin',
      HOME: '/home/operator',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    });
  });
  it('rejects client-shaped process selectors', () => {
    expect(() =>
      terminalProcessSpec({ ...record, id: 'term-a; rm -rf /' }, 'mitzo-test', 'attach'),
    ).toThrow();
    expect(() => terminalProcessSpec(record, 'other;server', 'attach')).toThrow();
  });
  it('connects the exact server-selected sandbox through the existing gateway SSH transport', () => {
    const runtime = {
      sandboxName: 'chat-original',
      sandboxId: 'original-id',
      workdir: '/sandbox/workspaces/task',
      appServerCommand: '/sandbox/run-mitzo-app-server' as const,
      cli: 'openshell',
      gateway: 'staging',
      workspace: 'default',
      gatewayInsecure: false,
    };
    const spec = terminalProcessSpec(
      {
        ...record,
        kind: 'sandbox',
        cwd: runtime.workdir,
        target: { ...record.target!, kind: 'sandbox', cwd: runtime.workdir, runtime },
      },
      'mitzo-test',
      'attach',
      {
        sandboxId: 'original-id',
        proxyUrl: 'https://gateway.test:9443/proxy/connect',
        token: 'ephemeral-token',
      },
    );
    expect(spec.command).toBe('ssh');
    expect(spec.args[0]).toBe('-tt');
    expect(spec.args).toContain('sandbox@openshell-chat-original.default');
    expect(spec.args.at(-1)).toContain("'tmux' '-L' 'mitzo-test'");
    expect(spec.args.at(-1)).toContain(record.id);
  });
  it('refuses a sandbox without a verified runtime instead of using the host', () => {
    expect(() =>
      terminalProcessSpec(
        { ...record, kind: 'sandbox', target: { ...record.target!, kind: 'sandbox' } },
        'mitzo-test',
        'attach',
      ),
    ).toThrow('Sandbox terminal unavailable');
  });
});

it('never creates a fresh shell when resuming a missing persisted session', () => {
  const spec = terminalProcessSpec(record, 'mitzo-test', 'resume');
  expect(spec.args).toEqual([
    '-L',
    'mitzo-test',
    '-f',
    '/dev/null',
    'attach-session',
    '-t',
    record.id,
  ]);
  expect(spec.args).not.toContain('new-session');
});

it('pins the SSH proxy to an immutable sandbox ID and never resolves a recycled name', () => {
  const runtime = {
    sandboxName: 'chat-original',
    sandboxId: 'original-id',
    workdir: '/sandbox/workspaces/task',
    appServerCommand: '/sandbox/run-mitzo-app-server' as const,
    cli: 'openshell',
    gateway: 'staging',
    workspace: 'default',
    gatewayInsecure: false,
  };
  const sandbox = {
    ...record,
    kind: 'sandbox' as const,
    cwd: runtime.workdir,
    target: { ...record.target!, kind: 'sandbox' as const, cwd: runtime.workdir, runtime },
  };
  const grant = {
    sandboxId: 'original-id',
    proxyUrl: 'https://gateway.test:9443/proxy/connect',
    token: 'ephemeral-token',
  };
  const spec = terminalProcessSpec(sandbox, 'mitzo-test', 'attach', grant);
  const proxy = spec.args.find((value) => value.startsWith('ProxyCommand='))!;
  expect(proxy).toContain("--sandbox-id 'original-id'");
  expect(proxy).not.toContain('--name');
  expect(() =>
    terminalProcessSpec(sandbox, 'mitzo-test', 'attach', { ...grant, sandboxId: 'replacement' }),
  ).toThrow();
  expect(() => terminalProcessSpec(sandbox, 'mitzo-test', 'attach')).toThrow('SSH');
});

it('uses fixed tmux history commands with bounded counts and an exact owned session target', () => {
  const spec = terminalProcessSpec(record, 'mitzo-test', 'scroll', undefined, {}, -20);
  expect(spec.args.slice(4)).toEqual([
    'copy-mode',
    '-e',
    '-t',
    `=${record.id}:`,
    ';',
    'send-keys',
    '-X',
    '-N',
    '20',
    '-t',
    `=${record.id}:`,
    'scroll-up',
  ]);
  expect(terminalProcessSpec(record, 'mitzo-test', 'scroll', undefined, {}, null).args).toContain(
    '#{pane_in_mode}',
  );
  expect(() => terminalProcessSpec(record, 'mitzo-test', 'scroll', undefined, {}, 101)).toThrow();
});
