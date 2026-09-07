import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAppServerClient, codexEnvironment } from '../codex-app-server-client.js';

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
    expect(sent[0]).toMatchObject({ method: 'initialize' });
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

  it('rejects unhandled server requests instead of allowing tools', async () => {
    const { child, sent, reply } = processStub();
    const client = new CodexAppServerClient(child);
    reply({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: {} });
    expect(sent[0]).toMatchObject({ id: 'approval-1', error: { code: -32601 } });
    client.close();
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
});
