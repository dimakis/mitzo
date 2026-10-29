import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { CodexAppServerClient, CodexTransportError } from '../codex-app-server-client.js';
function setup() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  const sent: Record<string, unknown>[] = [];
  child.stdin.on('data', (c) => sent.push(JSON.parse(c.toString())));
  const reply = (m: unknown) => child.stdout.write(JSON.stringify(m) + '\n');
  return { child, sent, reply };
}
it('streams notifications and awaits host tool results without blocking turn completion', async () => {
  const { child, sent, reply } = setup();
  const events: string[] = [];
  let finish!: (r: Record<string, unknown>) => void;
  const client = new CodexAppServerClient(child, {
    lifecycle: {
      onNotification: (method) => events.push(method),
      onRequest: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      onClose: () => {},
    },
  });
  const init = client.initialize();
  reply({ id: sent[0].id, result: {} });
  await init;
  const turn = client.request('turn/start', { threadId: 'thread' });
  reply({ id: 'tool', method: 'item/tool/call', params: { threadId: 'thread' } });
  reply({ method: 'turn/completed', params: {} });
  reply({ id: sent[2].id, result: { turn: { id: 'turn' } } });
  await expect(turn).resolves.toEqual({ turn: { id: 'turn' } });
  expect(events).toEqual(['turn/completed']);
  await vi.waitFor(() => expect(finish).toBeDefined());
  finish({ success: true, contentItems: [] });
  await vi.waitFor(() =>
    expect(sent.at(-1)).toEqual({ id: 'tool', result: { success: true, contentItems: [] } }),
  );
  await expect(client.request('account/logout', {})).rejects.toThrow('not supported');
  client.close();
});
it('aborts outstanding host work on process loss and discards late replies', async () => {
  const { child, sent, reply } = setup();
  let signal!: AbortSignal;
  let finish!: (r: Record<string, unknown>) => void;
  const closed = vi.fn();
  const client = new CodexAppServerClient(child, {
    lifecycle: {
      onNotification: () => {},
      onClose: closed,
      onRequest: (_method, _params, s) => {
        signal = s;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    },
  });
  reply({ id: 42, method: 'item/tool/call', params: {} });
  await vi.waitFor(() => expect(signal).toBeDefined());
  child.emit('exit', 1);
  expect(signal.aborted).toBe(true);
  expect(closed).toHaveBeenCalledOnce();
  finish({ success: true });
  await Promise.resolve();
  await Promise.resolve();
  expect(sent).toEqual([]);
  client.close();
  expect(closed).toHaveBeenCalledOnce();
});
it('redacts rejected host requests', async () => {
  const { child, sent, reply } = setup();
  const request = vi.fn(async () => {
    throw new Error('private credential');
  });
  const client = new CodexAppServerClient(child, {
    lifecycle: { onNotification: () => {}, onClose: () => {}, onRequest: request },
  });
  reply({ id: 1, method: 'item/tool/call', params: {} });
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  expect(JSON.stringify(sent)).not.toContain('private credential');
  expect(sent[0]).toMatchObject({
    id: 1,
    result: {
      success: false,
      contentItems: [
        {
          type: 'inputText',
          text: 'Mitzo could not dispatch this tool request. No external action was confirmed. Inspect current state before retrying.',
        },
      ],
    },
  });
  client.close();
});

it('rejects a duplicate in-flight host request without repeating an effect', async () => {
  const { child, sent, reply } = setup();
  const request = vi.fn(() => new Promise<Record<string, unknown>>(() => {}));
  const client = new CodexAppServerClient(child, {
    lifecycle: { onNotification: () => {}, onClose: () => {}, onRequest: request },
  });
  reply({ id: 1, method: 'item/tool/call', params: {} });
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  reply({ id: 1, method: 'item/tool/call', params: {} });
  expect(sent).toContainEqual({
    id: 1,
    error: { code: -32600, message: 'Duplicate Codex request' },
  });
  expect(child.kill).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledOnce();
  client.close();
});

it('allows configuration inspection on the lifecycle connection before creating a thread', async () => {
  const { child, sent, reply } = setup();
  const client = new CodexAppServerClient(child, {
    lifecycle: { onNotification: () => {}, onClose: () => {}, onRequest: async () => ({}) },
  });
  const init = client.initialize();
  reply({ id: sent[0].id, result: {} });
  await init;
  const config = client.request('config/read', { includeLayers: false });
  reply({ id: sent.at(-1)!.id, result: { config: {} } });
  await expect(config).resolves.toEqual({ config: {} });
  client.close();
});

it.each([
  ['exit', 23, null, { reason: 'child_exit', exitCode: 23, signal: null }],
  ['exit', null, 'SIGTERM', { reason: 'child_exit', exitCode: null, signal: 'SIGTERM' }],
  ['stdin', null, null, { reason: 'stream_error', stream: 'stdin', causeCode: 'EPIPE' }],
  ['stdout', null, null, { reason: 'stream_error', stream: 'stdout', causeCode: 'EPIPE' }],
  ['stderr', null, null, { reason: 'stream_error', stream: 'stderr', causeCode: 'EPIPE' }],
  ['error', null, null, { reason: 'process_error', causeCode: 'EPIPE' }],
] as const)(
  'retains the first safe native cause from %s and never repeats pending work',
  async (event, code, signal, diagnostic) => {
    const { child, sent, reply } = setup();
    const closed = vi.fn();
    const client = new CodexAppServerClient(child, {
      lifecycle: { onNotification: () => {}, onRequest: async () => ({}), onClose: closed },
    });
    const init = client.initialize();
    reply({ id: sent[0].id, result: {} });
    await init;
    const pending = client.request('turn/start', { threadId: 'thread' });
    const rejected = expect(pending).rejects.toMatchObject({ category: 'connection', diagnostic });
    if (event === 'exit') child.emit('exit', code, signal);
    else {
      const source = event === 'error' ? child : child[event];
      source.emit(
        'error',
        Object.assign(new Error('SECRET provider path /private/token'), { code: 'EPIPE' }),
      );
    }
    await rejected;
    child.emit('exit', 99, 'SIGKILL');
    expect(closed).toHaveBeenCalledOnce();
    const error = closed.mock.calls[0][0];
    expect(error).toBeInstanceOf(CodexTransportError);
    expect(error.diagnostic).toEqual(diagnostic);
    expect(JSON.stringify(error)).not.toContain('SECRET');
    expect(sent.filter((frame) => frame.method === 'turn/start')).toHaveLength(1);
  },
);

it('retains a typed stdin write-callback failure before a subsequent stream error', async () => {
  const { child, sent, reply } = setup();
  const closed = vi.fn();
  const client = new CodexAppServerClient(child, {
    observeTurnStartWrite: () => {},
    lifecycle: { onNotification: () => {}, onRequest: async () => ({}), onClose: closed },
  });
  const init = client.initialize();
  reply({ id: sent[0].id, result: {} });
  await init;
  vi.spyOn(child.stdin, 'write').mockImplementation((...args: unknown[]) => {
    const callback = args.find(
      (value): value is (error?: Error | null) => void => typeof value === 'function',
    );
    callback?.(Object.assign(Error('SECRET /private'), { code: 'EPIPE' }));
    return false;
  });
  await expect(
    client.request('turn/start', {
      threadId: 'thread',
      clientUserMessageId: 'command',
      input: [{ type: 'text', text: 'offline' }],
    }),
  ).rejects.toMatchObject({
    diagnostic: { reason: 'stream_error', stream: 'stdin', causeCode: 'EPIPE' },
  });
  expect(closed).toHaveBeenCalledOnce();
});
