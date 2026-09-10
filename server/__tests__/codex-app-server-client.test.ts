import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CodexAppServerClient,
  codexEnvironment,
  openShellCodexProcessSpec,
  terminateOpenShellProcess,
} from '../codex-app-server-client.js';

vi.mock('../application-version.js', () => ({ applicationVersion: '9.8.7-test' }));

function processStub() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  const sent: Record<string, unknown>[] = [];
  child.stdin.on('data', (chunk) => sent.push(JSON.parse(chunk.toString())));
  const reply = (value: unknown) => child.stdout.write(JSON.stringify(value) + '\n');
  return { child, sent, reply };
}

afterEach(() => vi.useRealTimers());
describe('Codex app-server transport', () => {
  it('blocks execution and auth mutations until a lifecycle policy bridge exists', async () => {
    const { child, sent, reply } = processStub();
    const client = new CodexAppServerClient(child);
    const ready = client.initialize();
    reply({ id: sent[0].id, result: {} });
    await ready;
    for (const method of [
      'turn/start',
      'thread/start',
      'thread/resume',
      'account/login/start',
      'account/logout',
    ]) {
      const request = client.request(method, {});
      if (sent.length > 2) reply({ id: sent.at(-1)!.id, result: {} });
      await expect(request).rejects.toThrow('preflight only');
    }
    expect(sent).toHaveLength(2);
    client.close();
  });
  it('initializes before requests and correlates fragmented, out-of-order responses', async () => {
    const { child, sent, reply } = processStub();
    const client = new CodexAppServerClient(child);
    const ready = client.initialize();
    expect(sent[0]).toMatchObject({
      method: 'initialize',
      params: { clientInfo: { version: '9.8.7-test' } },
    });
    reply({ id: sent[0].id, result: {} });
    await ready;
    expect(sent[1]).toMatchObject({ method: 'initialized' });
    const a = client.request('account/read', { refreshToken: false });
    const b = client.request('model/list', {});
    reply({ id: sent[3].id, result: { data: [] } });
    const frame = JSON.stringify({ id: sent[2].id, result: { account: null } });
    child.stdout.write(frame.slice(0, 9));
    child.stdout.write(frame.slice(9) + '\n');
    await expect(a).resolves.toEqual({ account: null });
    await expect(b).resolves.toEqual({ data: [] });
    client.close();
  });

  it('rejects pending work on exit and never exposes provider error details', async () => {
    const { child, sent, reply } = processStub();
    const client = new CodexAppServerClient(child);
    const ready = client.initialize();
    reply({ id: sent[0].id, result: {} });
    await ready;
    const request = client.request('account/read', {});
    reply({ id: sent[2].id, error: { message: 'private-secret' } });
    await expect(request).rejects.toThrow('Codex request failed');
    await expect(request).rejects.not.toThrow('private-secret');
    const pending = client.request('model/list', {});
    child.emit('exit', 1);
    await expect(pending).rejects.toThrow('Codex connection closed');
    await expect(client.request('model/list', {})).rejects.toThrow('closed');
  });

  it('closes on timeout so an uncertain request cannot be retried on the same connection', async () => {
    vi.useFakeTimers();
    const { child } = processStub();
    const client = new CodexAppServerClient(child, { timeoutMs: 10 });
    const result = expect(client.initialize()).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(11);
    await result;
    expect(child.kill).toHaveBeenCalled();
  });

  it('fails closed on oversized and malformed protocol frames', async () => {
    for (const frame of ['{broken}\n', 'x'.repeat(65)]) {
      const { child } = processStub();
      const client = new CodexAppServerClient(child, { maxFrameBytes: 64 });
      const pending = expect(client.initialize()).rejects.toThrow('Invalid Codex protocol');
      child.stdout.write(frame);
      await pending;
      expect(child.kill).toHaveBeenCalled();
    }
  });

  it('reports a failed server-request reply as a connection failure without exposing details', async () => {
    const { child, sent, reply } = processStub();
    const client = new CodexAppServerClient(child);
    const ready = client.initialize();
    reply({ id: sent[0].id, result: {} });
    await ready;
    const pending = client.request('account/read', {});
    vi.spyOn(child.stdin, 'write').mockImplementation(() => {
      throw new Error('private-write-secret');
    });
    reply({ id: 'approval', method: 'tool/approval', params: {} });
    await expect(pending).rejects.toThrow('Codex connection closed');
    await expect(pending).rejects.not.toThrow('private-write-secret');
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('rejects unhandled server requests instead of allowing tools', async () => {
    const { child, sent, reply } = processStub();
    const client = new CodexAppServerClient(child);
    reply({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: {} });
    expect(sent[0]).toMatchObject({ id: 'approval-1', error: { code: -32601 } });
    client.close();
  });

  it('rejects a duplicate host request without closing or executing it twice', async () => {
    const { child, sent, reply } = processStub();
    let release!: (value: Record<string, unknown>) => void;
    const result = new Promise<Record<string, unknown>>((resolve) => {
      release = resolve;
    });
    const lifecycle = {
      onNotification: vi.fn(),
      onRequest: vi.fn(() => result),
      onClose: vi.fn(),
    };
    const client = new CodexAppServerClient(child, { lifecycle });
    reply({ id: 'host-1', method: 'item/tool/call', params: {} });
    reply({ id: 'host-1', method: 'item/tool/call', params: {} });
    await vi.waitFor(() => expect(lifecycle.onRequest).toHaveBeenCalledTimes(1));
    expect(sent).toContainEqual({
      id: 'host-1',
      error: { code: -32600, message: 'Duplicate Codex request' },
    });
    expect(child.kill).not.toHaveBeenCalled();
    release({ ok: true });
    await vi.waitFor(() => expect(sent).toContainEqual({ id: 'host-1', result: { ok: true } }));
    expect(child.kill).not.toHaveBeenCalled();
    client.close();
  });

  it('ignores unsolicited notifications without replying or closing the connection', async () => {
    const { child, sent, reply } = processStub();
    const client = new CodexAppServerClient(child);
    const ready = client.initialize();
    reply({ id: sent[0].id, result: {} });
    await ready;
    const before = sent.length;
    reply({ method: 'some/event', params: {} });
    expect(sent).toHaveLength(before);
    expect(child.kill).not.toHaveBeenCalled();
    const pending = client.request('account/read', {});
    reply({ id: sent.at(-1)!.id, result: { account: null } });
    await expect(pending).resolves.toEqual({ account: null });
    client.close();
  });

  it('rejects a relative login directory at the environment boundary', () => {
    expect(() => codexEnvironment('relative/path', {})).toThrow('absolute');
  });

  it('requires initialization and isolates explicit ChatGPT credentials from inherited API routes', async () => {
    const { child } = processStub();
    const client = new CodexAppServerClient(child);
    await expect(client.request('turn/start', {})).rejects.toThrow('not initialized');
    expect(
      codexEnvironment('/explicit/codex-home', {
        PATH: '/bin',
        HOME: '/user',
        OPENAI_API_KEY: 'work-secret',
        ANTHROPIC_API_KEY: 'secret',
        CODEX_HOME: '/other',
        CODEX_API_KEY: 'secret',
        GOOGLE_APPLICATION_CREDENTIALS: '/work/adc',
        RANDOM_SECRET: 'secret',
      }),
    ).toEqual({ PATH: '/bin', HOME: '/user', CODEX_HOME: '/explicit/codex-home' });
    client.close();
  });

  it('builds a credential-free OpenShell app-server process boundary', () => {
    expect(
      openShellCodexProcessSpec(
        {
          sandboxName: 'mitzo-session-ab12',
          workdir: '/sandbox/workspaces/mgmt',
        },
        {
          PATH: '/bin',
          HOME: '/Users/test',
          OPENAI_API_KEY: 'must-not-cross',
          GITHUB_TOKEN: 'must-not-cross',
          OPENSHELL_WORKSPACE: 'mitzo-dev',
        },
      ),
    ).toEqual({
      command: 'ssh',
      args: [
        '-T',
        '-o',
        'BatchMode=yes',
        '-o',
        'StrictHostKeyChecking=no',
        '-o',
        'UserKnownHostsFile=/dev/null',
        '-o',
        'LogLevel=ERROR',
        '-o',
        'ProxyCommand=openshell ssh-proxy --gateway-name openshell --name mitzo-session-ab12 --workspace mitzo-dev',
        'sandbox@openshell-mitzo-session-ab12.mitzo-dev',
        '/sandbox/run-mitzo-app-server',
      ],
      env: { PATH: '/bin', HOME: '/Users/test', OPENSHELL_WORKSPACE: 'mitzo-dev' },
    });
    expect(() =>
      openShellCodexProcessSpec({ sandboxName: '../other', workdir: '/sandbox/workspaces/mgmt' }),
    ).toThrow(/sandbox name/i);
    expect(() => openShellCodexProcessSpec({ sandboxName: 'safe', workdir: '/host/path' })).toThrow(
      /workdir/i,
    );
  });

  it('terminates the SSH proxy process group on close', () => {
    const fallback = vi.fn();
    const killGroup = vi.fn();
    terminateOpenShellProcess({ pid: 42, kill: fallback }, killGroup);
    expect(killGroup).toHaveBeenCalledWith(-42, 'SIGTERM');
    expect(fallback).not.toHaveBeenCalled();
  });
});
