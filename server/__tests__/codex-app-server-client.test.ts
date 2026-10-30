import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifiedRuntimeServiceEnvironment } from '../openshell-runtime-policy.js';
import { tracer } from '../tracing.js';
import { BorrowedCodexSearch } from '../codex-borrowed-search.js';
import { searchCodex } from '../codex-approved-search.js';
import {
  codexRuntimeErrorTelemetry,
  codexRuntimeDiagnostic,
} from '../codex-runtime-diagnostics.js';
import { SpanStatusCode, type Span } from '@opentelemetry/api';
import { base, fixture } from './fixtures/effective-runtime-policy.js';
import {
  CodexAppServerClient,
  CodexRequestError,
  CodexTransportError,
  CodexHostToolRequestError,
  SUPPORTED_CODEX_CLI_VERSION,
  assertSupportedCodexCliVersion,
  type OpenShellCodexOptions,
  type CodexLifecycleTransport,
  codexEnvironment,
  openShellCodexProcessSpec,
  openShellSshProcessSpec,
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
  it.each(['success', 'timeout', 'rejected', 'closed'] as const)(
    'ends a bounded RPC trace on %s without recording private frames or errors',
    async (outcome) => {
      vi.useFakeTimers();
      const spans: Array<{
        setAttribute: ReturnType<typeof vi.fn>;
        setStatus: ReturnType<typeof vi.fn>;
        end: ReturnType<typeof vi.fn>;
      }> = [];
      const spy = vi.spyOn(tracer, 'startSpan').mockImplementation(() => {
        const span = { setAttribute: vi.fn(), setStatus: vi.fn(), end: vi.fn() };
        spans.push(span);
        return span as unknown as Span;
      });
      const { child, sent, reply } = processStub();
      const client = new CodexAppServerClient(child, { timeoutMs: 10 });
      try {
        const ready = client.initialize();
        reply({ id: sent[0].id, result: { private: 'PRIVATE-INIT' } });
        await ready;
        expect(spans[0]?.end).toHaveBeenCalledOnce();
        const request = client.request('account/read', { private: 'PRIVATE-REQUEST' });
        const check =
          outcome === 'success'
            ? expect(request).resolves.toEqual({ private: 'PRIVATE-RESPONSE' })
            : expect(request).rejects.toBeInstanceOf(Error);
        if (outcome === 'success')
          reply({ id: sent.at(-1)!.id, result: { private: 'PRIVATE-RESPONSE' } });
        else if (outcome === 'rejected')
          reply({ id: sent.at(-1)!.id, error: { message: 'PRIVATE-PROVIDER-ERROR' } });
        else if (outcome === 'closed') client.close(new Error('PRIVATE-CLOSE-ERROR'));
        else await vi.advanceTimersByTimeAsync(10);
        await check;
        expect(spy).toHaveBeenLastCalledWith(
          'codex.rpc',
          expect.objectContaining({
            attributes: {
              'rpc.system': 'jsonrpc',
              'rpc.method': 'account/read',
              'rpc.timeout_ms': 10,
            },
          }),
        );
        expect(spans[1]?.end).toHaveBeenCalledOnce();
        expect(spans[1]?.setStatus).toHaveBeenCalledWith({
          code: outcome === 'success' ? SpanStatusCode.OK : SpanStatusCode.ERROR,
        });
        expect(
          JSON.stringify([
            spy.mock.calls,
            ...spans.map((s) => [s.setAttribute.mock.calls, s.setStatus.mock.calls]),
          ]),
        ).not.toContain('PRIVATE');
      } finally {
        client.close();
        spy.mockRestore();
      }
    },
  );
  it('preserves execution authentication classification for native routing errors', async () => {
    const { child, sent, reply } = processStub();
    const client = new CodexAppServerClient(child, {
      lifecycle: { onNotification: vi.fn(), onRequest: vi.fn(async () => ({})), onClose: vi.fn() },
    });
    const ready = client.initialize();
    reply({ id: sent[0].id, result: {} });
    await ready;
    const request = client.request('turn/start', {});
    reply({
      id: sent.at(-1)!.id,
      error: { code: -32603, message: 'workspace routing discovery unauthorized (401)' },
    });
    await expect(request).rejects.toMatchObject({ category: 'authentication' });
    client.close();
  });
  it.each(['timeout', 'connection', 'protocol'] as const)(
    'uses a typed %s transport failure without private data',
    async (category) => {
      vi.useFakeTimers();
      const { child } = processStub();
      const client = new CodexAppServerClient(child, { timeoutMs: 10 });
      const request = client.initialize();
      const check = expect(request).rejects.toMatchObject({
        name: 'CodexTransportError',
        category,
      });
      if (category === 'timeout') await vi.advanceTimersByTimeAsync(11);
      else if (category === 'connection') child.emit('exit', 1);
      else child.stdout.write('{PRIVATE-TOKEN}\n');
      await check;
      await expect(request).rejects.toBeInstanceOf(CodexTransportError);
      await expect(request).rejects.not.toThrow('PRIVATE-TOKEN');
    },
  );

  it('uses the same version pin as the image and sandbox launchers', () => {
    expect(SUPPORTED_CODEX_CLI_VERSION).toBe(
      readFileSync(
        new URL('../../docs/spikes/openshell-codex/runtime-codex-version', import.meta.url),
        'utf8',
      ).trim(),
    );
  });
  it('accepts only the reviewed Codex CLI contract version', () => {
    expect(() =>
      assertSupportedCodexCliVersion(`codex-cli ${SUPPORTED_CODEX_CLI_VERSION}\n`),
    ).not.toThrow();
    expect(() => assertSupportedCodexCliVersion('codex-cli 0.153.5\n')).toThrow(
      'Unsupported Codex CLI version',
    );
    expect(() => assertSupportedCodexCliVersion('unexpected output')).toThrow(
      'Unsupported Codex CLI version',
    );
  });
  it('rejects shell metacharacters in the legacy remote command API', () => {
    const options = { sandboxName: 'mitzo-x', workdir: '/sandbox/workspaces/mgmt' };
    expect(() => openShellSshProcessSpec(options, '/sandbox/tool;$(touch /tmp/pwned)')).toThrow(
      'remote command',
    );
    expect(() => openShellSshProcessSpec(options, '/sandbox/tool --safe')).not.toThrow();
  });
  it('blocks execution and auth mutations until a lifecycle policy bridge exists', async () => {
    const { child, sent, reply } = processStub();
    const client = new CodexAppServerClient(child);
    const ready = client.initialize();
    reply({ id: sent[0].id, result: {} });
    await ready;
    for (const method of [
      'turn/start',
      'turn/steer',
      'thread/start',
      'thread/resume',
      'thread/unsubscribe',
      'account/login/start',
      'account/logout',
      'skills/list',
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

  it('allows lifecycle recovery to page turns and fork a metadata-only provider thread', async () => {
    const { child, sent, reply } = processStub();
    const lifecycle = {
      onNotification: vi.fn(),
      onRequest: vi.fn(async () => ({})),
      onClose: vi.fn(),
    };
    const client = new CodexAppServerClient(child, { lifecycle });
    const ready = client.initialize();
    reply({ id: sent[0].id, result: {} });
    await ready;

    const skills = client.request('skills/list', { cwds: ['/workspace'], forceReload: false });
    expect(sent.at(-1)).toMatchObject({
      method: 'skills/list',
      params: { cwds: ['/workspace'], forceReload: false },
    });
    reply({ id: sent.at(-1)!.id, result: { data: [] } });
    await expect(skills).resolves.toEqual({ data: [] });

    const turns = client.request('thread/turns/list', {
      threadId: 'old-thread',
      limit: 64,
      sortDirection: 'desc',
      itemsView: 'notLoaded',
    });
    expect(sent.at(-1)).toMatchObject({
      method: 'thread/turns/list',
      params: {
        threadId: 'old-thread',
        limit: 64,
        sortDirection: 'desc',
        itemsView: 'notLoaded',
      },
    });
    reply({ id: sent.at(-1)!.id, result: { data: [], nextCursor: null } });
    await expect(turns).resolves.toEqual({ data: [], nextCursor: null });

    const fork = client.request('thread/fork', {
      threadId: 'old-thread',
      lastTurnId: 'last-good-turn',
      excludeTurns: true,
    });
    expect(sent.at(-1)).toMatchObject({
      method: 'thread/fork',
      params: { threadId: 'old-thread', lastTurnId: 'last-good-turn', excludeTurns: true },
    });
    reply({ id: sent.at(-1)!.id, result: { thread: { id: 'new-thread' } } });
    await expect(fork).resolves.toEqual({ thread: { id: 'new-thread' } });
    client.close();
  });

  it('cleans up an approved search through the real RPC gate and keeps the parent usable', async () => {
    const { child, sent, reply } = processStub();
    const client = new CodexAppServerClient(child, {
      lifecycle: {
        onNotification: (method, params) => {
          search.notification(method, params);
        },
        onRequest: vi.fn(async () => {
          throw Error('No executable child tools');
        }),
        onClose: vi.fn(),
      },
    });
    const ready = client.initialize();
    reply({ id: sent[0].id, result: {} });
    await ready;
    const search = new BorrowedCodexSearch(client, 'parent', async () => {});
    child.stdin.on('data', (chunk) => {
      const frame = JSON.parse(chunk.toString());
      queueMicrotask(() => {
        if (frame.method === 'config/read') reply({ id: frame.id, result: { config: {} } });
        if (frame.method === 'thread/start')
          reply({
            id: frame.id,
            result: { thread: { id: 'search' }, model: 'offline-model', modelProvider: 'openai' },
          });
        if (frame.method === 'turn/start') {
          reply({ id: frame.id, result: { turn: { id: 'search-turn' } } });
          reply({
            method: 'item/completed',
            params: {
              threadId: 'search',
              turnId: 'search-turn',
              item: { type: 'webSearch', id: 'receipt', query: 'offline query' },
            },
          });
          reply({
            method: 'item/completed',
            params: {
              threadId: 'search',
              turnId: 'search-turn',
              item: { type: 'agentMessage', text: 'Evidence https://example.test/source' },
            },
          });
          reply({
            method: 'turn/completed',
            params: { threadId: 'search', turn: { id: 'search-turn', status: 'completed' } },
          });
        }
        if (frame.method === 'thread/unsubscribe' || frame.method === 'account/read')
          reply({ id: frame.id, result: {} });
      });
    });
    try {
      await expect(
        searchCodex('offline query', new AbortController().signal, {
          createClient: (callbacks) => search.attach(callbacks),
          verify: async () => {},
          model: 'offline-model',
          modelProvider: 'openai',
          cwd: '/offline',
        }),
      ).resolves.toContain('https://example.test/source');
      expect(sent).toContainEqual(
        expect.objectContaining({ method: 'thread/unsubscribe', params: { threadId: 'search' } }),
      );
      expect(child.kill).not.toHaveBeenCalled();
      await expect(client.request('account/read', {})).resolves.toEqual({});
    } finally {
      client.close();
    }
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
    await expect(request).rejects.toMatchObject({
      name: 'CodexRequestError',
      method: 'account/read',
      category: 'unknown',
    });
    const pending = client.request('model/list', {});
    child.emit('exit', 1);
    await expect(pending).rejects.toThrow('Codex connection closed');
    await expect(client.request('model/list', {})).rejects.toThrow('closed');
  });

  it('classifies thread-state rejection without retaining provider text', async () => {
    const { child, sent, reply } = processStub();
    const lifecycle = {
      onNotification: vi.fn(),
      onRequest: vi.fn(async () => ({})),
      onClose: vi.fn(),
    };
    const client = new CodexAppServerClient(child, { lifecycle });
    const ready = client.initialize();
    reply({ id: sent[0].id, result: {} });
    await ready;
    const request = client.request('turn/start', {});
    reply({
      id: sent.at(-1)!.id,
      error: { code: -32000, message: 'thread has an active turn SECRET_SENTINEL' },
    });
    const error = await request.catch((value: unknown) => value);
    expect(error).toBeInstanceOf(CodexRequestError);
    expect(error).toMatchObject({
      method: 'turn/start',
      category: 'thread_state',
      code: -32000,
    });
    expect((error as Error).message).not.toContain('SECRET_SENTINEL');
    client.close();
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

  it('receives large native user-message echoes and remains usable for the next RPC', async () => {
    const { child, sent, reply } = processStub();
    const notifications: Array<{
      item: { content: Array<{ type: string; text?: string; url?: string }> };
    }> = [];
    const client = new CodexAppServerClient(child, {
      lifecycle: {
        onClose: vi.fn(),
        onRequest: vi.fn(),
        onNotification: (_method, params) => {
          notifications.push(params as (typeof notifications)[number]);
        },
      },
    });
    try {
      const ready = client.initialize();
      reply({ id: sent[0].id, result: {} });
      await ready;
      const text = 'x'.repeat(5 * 1024 * 1024);
      const image = 'data:image/png;base64,' + Buffer.alloc(128 * 1024).toString('base64');
      const params = {
        threadId: 'thread',
        turnId: 'turn',
        item: {
          id: 'item',
          type: 'userMessage',
          content: [
            { type: 'text', text: '\0'.repeat(64 * 1024) },
            { type: 'text', text: 'source'.repeat(300000) },
            { type: 'text', text },
            ...Array.from({ length: 30 }, () => ({ type: 'image', url: image })),
          ],
        },
      };
      for (const method of ['item/started', 'item/completed']) {
        const frame = Buffer.from(JSON.stringify({ method, params }) + '\n');
        for (let offset = 0; offset < frame.length; offset += 65536)
          child.stdout.write(frame.subarray(offset, offset + 65536));
      }
      expect(notifications).toHaveLength(2);
      expect(notifications[1].item.content[2].text === text).toBe(true);
      expect(notifications[1].item.content).toHaveLength(33);
      expect(notifications[1].item.content[32].url === image).toBe(true);
      const subsequent = client.request('account/read', {});
      reply({ id: sent.at(-1)!.id, result: { ok: true } });
      await expect(subsequent).resolves.toEqual({ ok: true });
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      client.close();
    }
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

  it.each([
    ['{PRIVATE-TOKEN}\n', 'invalid_json'],
    ['[]\n', 'invalid_envelope'],
    ['x'.repeat(65), 'frame_too_large'],
  ] as const)(
    'classifies framing failures without retaining their contents (%s)',
    async (frame, reason) => {
      const { child } = processStub();
      const client = new CodexAppServerClient(child, { maxFrameBytes: 64 });
      const pending = client.initialize();
      const check = expect(pending).rejects.toMatchObject({
        category: 'protocol',
        diagnostic: { reason, pendingRequestMethod: 'initialize' },
      });
      child.stdout.write(frame);
      await check;
      const error = await pending.catch((error: Error) => error);
      expect(codexRuntimeErrorTelemetry(error as Error)).toMatchObject({
        transportErrorCategory: 'protocol',
        transportFailureReason: reason,
        pendingRequestMethod: 'initialize',
      });
      expect(JSON.stringify(error)).not.toContain('PRIVATE-TOKEN');
      if (reason === 'frame_too_large') {
        expect(codexRuntimeErrorTelemetry(error as Error)).toMatchObject({
          transportFrameBytes: 65,
          transportFrameLimitBytes: 64,
        });
        expect(codexRuntimeDiagnostic(error as Error)).toContain('transport limit');
        expect(codexRuntimeDiagnostic(error as Error)).not.toContain('compatibility');
      }
    },
  );

  it('classifies a throwing event handler as an application delivery failure, not malformed protocol', async () => {
    const { child, sent, reply } = processStub();
    const onClose = vi.fn();
    const client = new CodexAppServerClient(child, {
      lifecycle: {
        onClose,
        onRequest: vi.fn(),
        onNotification: () => {
          throw new Error('PRIVATE-CALLBACK-TOKEN');
        },
      },
    });
    const ready = client.initialize();
    reply({ id: sent[0].id, result: {} });
    await ready;
    const pending = client.request('thread/resume', { threadId: 'retained', excludeTurns: true });
    const check = expect(pending).rejects.toMatchObject({
      category: 'connection',
      diagnostic: { reason: 'notification_handler_failed', pendingRequestMethod: 'thread/resume' },
    });
    reply({ method: 'thread/status/changed', params: { threadId: 'retained' } });
    await check;
    expect(onClose).toHaveBeenCalledOnce();
    expect(JSON.stringify(onClose.mock.calls)).not.toContain('PRIVATE-CALLBACK-TOKEN');
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('parses fragmented UTF-8 and coalesced frames without applying the limit to the whole chunk', async () => {
    const { child, sent, reply } = processStub();
    const notifications: unknown[] = [];
    const client = new CodexAppServerClient(child, {
      maxFrameBytes: 96,
      lifecycle: {
        onClose: vi.fn(),
        onRequest: vi.fn(),
        onNotification: (_method, params) => {
          notifications.push(params);
        },
      },
    });
    const ready = client.initialize();
    reply({ id: sent[0].id, result: {} });
    await ready;
    const frame = Buffer.from(
      JSON.stringify({ method: 'notice', params: { text: 'λ🙂'.repeat(5) } }) + '\n',
    );
    for (const byte of frame) child.stdout.write(Buffer.from([byte]));
    child.stdout.write(Buffer.concat([frame, frame]));
    expect(notifications).toEqual(Array.from({ length: 3 }, () => ({ text: 'λ🙂'.repeat(5) })));
    expect(child.kill).not.toHaveBeenCalled();
    client.close();
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

  it('never redispatches a settled host RPC id', async () => {
    const { child, sent, reply } = processStub();
    const lifecycle = {
      onNotification: vi.fn(),
      onRequest: vi.fn<CodexLifecycleTransport['onRequest']>(async () => ({ decision: 'accept' })),
      onClose: vi.fn(),
    };
    const client = new CodexAppServerClient(child, { lifecycle });
    const request = { id: 'native-1', method: 'item/commandExecution/requestApproval', params: {} };
    reply(request);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    reply(request);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(lifecycle.onRequest).toHaveBeenCalledTimes(1);
    expect(lifecycle.onRequest.mock.calls[0]?.[3]).toMatchObject({
      requestId: 'native-1',
      registerResponseFence: expect.any(Function),
    });
    expect(sent[1]).toMatchObject({ error: { code: -32600 } });
    client.close();
  });

  it('checks exact native authority synchronously at the response write boundary', async () => {
    const { child, sent, reply } = processStub();
    let current = true;
    let finish!: (result: Record<string, unknown>) => void;
    const lifecycle = {
      onNotification: vi.fn(),
      onRequest: vi.fn((_method, _params, _signal, context) => {
        context.registerResponseFence(() => {
          if (!current) throw Error('revoked');
        });
        return new Promise<Record<string, unknown>>((resolve) => {
          finish = resolve;
        });
      }),
      onClose: vi.fn(),
    };
    const client = new CodexAppServerClient(child, { lifecycle });
    reply({ id: 'fenced', method: 'item/commandExecution/requestApproval', params: {} });
    await vi.waitFor(() => expect(lifecycle.onRequest).toHaveBeenCalledTimes(1));
    finish({ decision: 'accept' });
    current = false;
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledOnce());
    expect(sent).toEqual([]);
    client.close();
  });

  it('rejects an asynchronous native response fence without emitting a grant', async () => {
    const { child, sent, reply } = processStub();
    const client = new CodexAppServerClient(child, {
      lifecycle: {
        onNotification: vi.fn(),
        onClose: vi.fn(),
        onRequest: async (_method, _params, _signal, context) => {
          context!.registerResponseFence!(async () => {
            throw Error('late revocation');
          });
          return { decision: 'accept' };
        },
      },
    });
    reply({ id: 'async-fence', method: 'item/commandExecution/requestApproval', params: {} });
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledOnce());
    expect(sent).toEqual([]);
    client.close();
  });

  it('aborts a resolved native server request and suppresses a late grant', async () => {
    const { child, sent, reply } = processStub();
    let finish!: (result: Record<string, unknown>) => void;
    let signal!: AbortSignal;
    const lifecycle = {
      onNotification: vi.fn(),
      onRequest: vi.fn((_method, _params, pendingSignal) => {
        signal = pendingSignal;
        return new Promise<Record<string, unknown>>((resolve) => {
          finish = resolve;
        });
      }),
      onClose: vi.fn(),
    };
    const client = new CodexAppServerClient(child, { lifecycle });
    reply({ id: 42, method: 'item/permissions/requestApproval', params: { threadId: 'thread' } });
    await vi.waitFor(() => expect(lifecycle.onRequest).toHaveBeenCalledTimes(1));
    reply({ method: 'serverRequest/resolved', params: { requestId: 42, threadId: 'thread' } });
    expect(signal.aborted).toBe(true);
    finish({ permissions: { fileSystem: { write: ['/outside'] } }, scope: 'turn' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent).toHaveLength(0);
    client.close();
  });

  it.each(['item/tool/call', 'item/tool/requestUserInput'])(
    'returns a safe tool failure only for dynamic tool calls (%s)',
    async (method) => {
      const { child, sent, reply } = processStub();
      const lifecycle = {
        onNotification: vi.fn(),
        onRequest: vi.fn(async () => {
          throw new Error('private URL bearer SECRET');
        }),
        onClose: vi.fn(),
      };
      const client = new CodexAppServerClient(child, { lifecycle });
      reply({ id: 'host-failed', method, params: { arguments: { secret: 'SECRET' } } });
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      if (method === 'item/tool/call') {
        expect(sent[0]).toEqual({
          id: 'host-failed',
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
      } else {
        expect(sent[0]).toEqual({
          id: 'host-failed',
          error: { code: -32603, message: 'Host request failed' },
        });
      }
      expect(JSON.stringify(sent)).not.toContain('SECRET');
      expect(child.kill).not.toHaveBeenCalled();
      client.close();
    },
  );

  it('preserves the bounded rejection class without exposing request data', async () => {
    const { child, sent, reply } = processStub();
    const lifecycle = {
      onNotification: vi.fn(),
      onRequest: vi.fn(async () => {
        const error = new CodexHostToolRequestError('tool_identity_mismatch');
        error.message = 'SECRET';
        throw error;
      }),
      onClose: vi.fn(),
    };
    const client = new CodexAppServerClient(child, { lifecycle });
    reply({ id: 'stale', method: 'item/tool/call', params: { threadId: 'SECRET' } });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({
      id: 'stale',
      result: {
        success: false,
        contentItems: [
          {
            type: 'inputText',
            text: new CodexHostToolRequestError('tool_identity_mismatch').message,
          },
        ],
      },
    });
    expect(JSON.stringify(sent)).not.toContain('SECRET');
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

  it('gates a same-launch provider environment without sending credential values or accepting invalid names', () => {
    const spec = openShellCodexProcessSpec({
      sandboxName: 'approved-sandbox',
      workdir: '/sandbox/workspaces/mgmt',
      requiredProviderEnvironment: ['GOOGLE_WORKSPACE_CLI_TOKEN'],
    });
    expect(spec.args.at(-1)).toContain('GOOGLE_WORKSPACE_CLI_TOKEN');
    expect(spec.args.at(-1)).toContain('exit 78');
    expect(spec.env).not.toHaveProperty('GOOGLE_WORKSPACE_CLI_TOKEN');
    expect(() =>
      openShellCodexProcessSpec({
        sandboxName: 'approved-sandbox',
        workdir: '/sandbox/workspaces/mgmt',
        requiredProviderEnvironment: ['TOKEN;touch /tmp/unreviewed'],
      }),
    ).toThrow('environment name');
  });

  it('checks the environment privately in the exact shell that execs the fake application', () => {
    const spec = openShellCodexProcessSpec({
      sandboxName: 'approved-sandbox',
      workdir: '/sandbox/workspaces/mgmt',
      requiredProviderEnvironment: ['GOOGLE_WORKSPACE_CLI_TOKEN'],
    });
    const remote = spec.args.at(-1)!.replaceAll('/sandbox/run-mitzo-app-server', '/usr/bin/true');
    try {
      execFileSync('/bin/sh', ['-c', remote], {
        env: {},
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      throw new Error('Missing environment should block the fake application');
    } catch (error) {
      expect(error).toMatchObject({ status: 78, stdout: '', stderr: '' });
    }
    expect(
      execFileSync('/bin/sh', ['-c', remote], {
        env: { GOOGLE_WORKSPACE_CLI_TOKEN: 'synthetic-placeholder' },
        encoding: 'utf8',
      }),
    ).toBe('');
  });

  it('launches with either reviewed GitHub alias while requiring every independent service credential', () => {
    const f = fixture(['mitzo-openai-keychain-spike', 'github', 'mitzo-google-workspace-spike']);
    const required = verifiedRuntimeServiceEnvironment(
      base,
      f.observed,
      f.providers,
      f.providers[0].name,
    );
    const spec = openShellCodexProcessSpec({
      sandboxName: 'approved-sandbox',
      workdir: '/sandbox/workspaces/mgmt',
      requiredProviderEnvironment: required,
    });
    const remote = spec.args.at(-1)!.replaceAll('/sandbox/run-mitzo-app-server', '/usr/bin/true');
    for (const alias of ['GITHUB_TOKEN', 'GH_TOKEN']) {
      expect(
        execFileSync('/bin/sh', ['-c', remote], {
          env: {
            [alias]: 'synthetic-github-placeholder',
            GOOGLE_WORKSPACE_CLI_TOKEN: 'synthetic-gws-placeholder',
          },
          encoding: 'utf8',
        }),
      ).toBe('');
    }
    for (const env of [
      {},
      { GITHUB_TOKEN: '', GH_TOKEN: '', GOOGLE_WORKSPACE_CLI_TOKEN: 'synthetic-gws-placeholder' },
      { GITHUB_TOKEN: 'synthetic-github-placeholder' },
      { GOOGLE_WORKSPACE_CLI_TOKEN: 'synthetic-gws-placeholder' },
    ]) {
      expect(() => execFileSync('/bin/sh', ['-c', remote], { env, stdio: 'pipe' })).toThrow(
        expect.objectContaining({ status: 78, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
      );
    }
  });

  it('rejects malformed credential alternative groups before launching', () => {
    for (const requiredProviderEnvironment of [
      [[]],
      [['GH_TOKEN', 'TOKEN;touch /tmp/unreviewed']],
      [Array.from({ length: 65 }, (_, i) => `TOKEN_${i}`)],
    ]) {
      expect(() =>
        openShellCodexProcessSpec({
          sandboxName: 'approved-sandbox',
          workdir: '/sandbox/workspaces/mgmt',
          requiredProviderEnvironment,
        }),
      ).toThrow('environment name');
    }
  });

  it('cancels pending environment retries when the client closes', async () => {
    vi.useFakeTimers();
    const first = processStub();
    const create = vi.fn();
    const client = new CodexAppServerClient(first.child, { environmentLaunch: { create } });
    const ready = client.initialize().catch(() => undefined);
    first.child.emit('exit', 78);
    client.close();
    await vi.advanceTimersByTimeAsync(30_000);
    await ready;
    expect(create).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries only missing provider environment before initialization and never starts a model turn', async () => {
    vi.useFakeTimers();
    const first = processStub();
    const second = processStub();
    const create = vi.fn(() => second.child);
    const closed = vi.fn();
    const client = new CodexAppServerClient(first.child, {
      environmentLaunch: { create },
      lifecycle: { onNotification: vi.fn(), onRequest: vi.fn(async () => ({})), onClose: closed },
    });
    const ready = client.initialize();
    first.child.emit('exit', 78);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(create).toHaveBeenCalledOnce();
    expect(closed).not.toHaveBeenCalled();
    expect(second.sent).toEqual(first.sent);
    expect(second.sent[0].method).toBe('initialize');
    second.reply({ id: second.sent[0].id, result: {} });
    await ready;
    expect(second.sent.some((frame) => frame.method === 'turn/start')).toBe(false);
    client.close();
  });

  it('reports bounded environment pending rather than usable or denied after all fresh launches miss credentials', async () => {
    vi.useFakeTimers();
    const peers = [processStub(), processStub(), processStub()];
    let next = 1;
    const client = new CodexAppServerClient(peers[0].child, {
      environmentLaunch: { create: () => peers[next++].child },
    });
    const ready = client.initialize();
    const rejected = expect(ready).rejects.toMatchObject({ category: 'environment_pending' });
    for (let attempt = 0; attempt < 3; attempt++) {
      peers[attempt].child.emit('exit', 78);
      if (attempt < 2) await vi.advanceTimersByTimeAsync(10_000);
    }
    await rejected;
    expect(next).toBe(3);
    expect(peers.every((peer) => peer.sent.every((frame) => frame.method === 'initialize'))).toBe(
      true,
    );
  });

  it('builds a credential-free OpenShell app-server process boundary', () => {
    expect(
      openShellCodexProcessSpec(
        {
          sandboxName: 'mitzo-session-ab12',
          workdir: '/sandbox/workspaces/mgmt',
          appServerCommand: '/sandbox/run-mitzo-subscription-app-server',
          cli: '/isolated/openshell',
          gateway: 'isolated',
          workspace: 'mitzo-dev',
          gatewayEndpoint: 'http://[::1]:18670',
          gatewayInsecure: true,
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
        "ProxyCommand=/isolated/openshell --gateway-insecure ssh-proxy --server 'http://[::1]:18670' --name mitzo-session-ab12 --workspace mitzo-dev",
        'sandbox@openshell-mitzo-session-ab12.mitzo-dev',
        '/sandbox/run-mitzo-subscription-app-server',
      ],
      env: { PATH: '/bin', HOME: '/Users/test', OPENSHELL_WORKSPACE: 'mitzo-dev' },
    });
    expect(() =>
      openShellCodexProcessSpec({ sandboxName: '../other', workdir: '/sandbox/workspaces/mgmt' }),
    ).toThrow(/sandbox name/i);
    expect(() => openShellCodexProcessSpec({ sandboxName: 'safe', workdir: '/host/path' })).toThrow(
      /workdir/i,
    );
    expect(() =>
      openShellCodexProcessSpec({
        sandboxName: 'safe',
        workdir: '/sandbox/workspaces/../other',
      }),
    ).toThrow(/workdir/i);
  });

  it('permits only validated non-secret Jira context in the remote app-server command', () => {
    const spec = openShellCodexProcessSpec({
      sandboxName: 'safe',
      workdir: '/sandbox/workspaces/mgmt',
      connectionEnv: {
        JIRA_URL: 'https://api.atlassian.com/ex/jira/2b9e35e3-6bd3-4cec-b838-f4249ee02432',
        JIRA_EMAIL: 'person@example.com',
      },
    });
    expect(spec.args.at(-1)).toBe(
      "env JIRA_URL='https://api.atlassian.com/ex/jira/2b9e35e3-6bd3-4cec-b838-f4249ee02432' JIRA_EMAIL='person@example.com' /sandbox/run-mitzo-app-server",
    );
    const quoted = openShellCodexProcessSpec({
      sandboxName: 'safe',
      workdir: '/sandbox/workspaces/mgmt',
      connectionEnv: {
        JIRA_URL: 'https://api.atlassian.com/ex/jira/2b9e35e3-6bd3-4cec-b838-f4249ee02432',
        JIRA_EMAIL: '`id`@example.com',
      },
    });
    expect(quoted.args.at(-1)).toContain("JIRA_EMAIL='`id`@example.com'");
  });

  it('rejects a different tenant in managed Jira context', () => {
    expect(() =>
      openShellCodexProcessSpec({
        sandboxName: 'safe',
        workdir: '/sandbox/workspaces/mgmt',
        connectionEnv: {
          JIRA_URL: 'https://api.atlassian.com/ex/jira/other-tenant',
          JIRA_EMAIL: 'person@example.com',
        } as unknown as OpenShellCodexOptions['connectionEnv'],
      }),
    ).toThrow('Invalid managed Jira connection environment');
  });

  it('terminates the SSH proxy process group on close', () => {
    const fallback = vi.fn();
    const killGroup = vi.fn();
    terminateOpenShellProcess({ pid: 42, kill: fallback }, killGroup);
    expect(killGroup).toHaveBeenCalledWith(-42, 'SIGTERM');
    expect(fallback).not.toHaveBeenCalled();
  });
});

it('rejects native Symposium command through the generic Codex launcher', () => {
  expect(() =>
    openShellCodexProcessSpec({
      sandboxName: 'personal-seat',
      workdir: '/sandbox/workspaces/mgmt',
      appServerCommand: '/usr/local/bin/symposium-subscription-app-server',
    }),
  ).toThrow('isolated Symposium controller');
});

it('permits only login/account RPCs in a dedicated login process even with a lifecycle observer', async () => {
  const { child, sent, reply } = processStub();
  const client = new CodexAppServerClient(child, {
    loginOnly: true,
    lifecycle: { onNotification: vi.fn(), onRequest: vi.fn(), onClose: vi.fn() },
  });
  const ready = client.initialize();
  reply({ id: sent[0].id, result: {} });
  await ready;
  for (const method of ['turn/start', 'turn/steer', 'thread/start', 'model/list', 'account/logout'])
    await expect(client.request(method, {})).rejects.toThrow();
  expect(sent).toHaveLength(2);
  const login = client.request('account/login/start', { type: 'chatgptDeviceCode' });
  reply({ id: sent.at(-1)!.id, result: { type: 'chatgptDeviceCode' } });
  await expect(login).resolves.toMatchObject({ type: 'chatgptDeviceCode' });
  client.close();
});
it('sends turn/steer through the real lifecycle transport with its exact expected turn and text', async () => {
  const { child, sent, reply } = processStub();
  const client = new CodexAppServerClient(child, {
    lifecycle: { onNotification: vi.fn(), onRequest: vi.fn(async () => ({})), onClose: vi.fn() },
  });
  const ready = client.initialize();
  reply({ id: sent[0].id, result: {} });
  await ready;
  const params = {
    threadId: 'original-thread',
    expectedTurnId: 'original-turn',
    input: [{ type: 'text', text: 'Keep the current priorities.' }],
  };
  const steering = client.request('turn/steer', params);
  expect(sent.at(-1)).toMatchObject({ method: 'turn/steer', params });
  reply({ id: sent.at(-1)!.id, result: { turnId: 'original-turn' } });
  await expect(steering).resolves.toEqual({ turnId: 'original-turn' });
  client.close();
});
