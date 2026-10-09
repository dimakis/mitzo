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
      'new-session',
      '-A',
      '-s',
      record.id,
      '-c',
      record.cwd,
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
