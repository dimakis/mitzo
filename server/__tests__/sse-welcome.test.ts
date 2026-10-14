import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import type { Request, Response } from 'express';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { ConnectionRegistry } from '@mitzo/harness';
import { SseConnection } from '../../packages/client/src/sse-connection.js';
import { SessionSseRegistry } from '../session-sse-registry.js';
import { SseTransport } from '../sse-transport.js';

// Execute the registered production route, without importing index's service bootstrap.
function eventsRoute(dependencies: Record<string, unknown>) {
  const source = ts.createSourceFile(
    'index.ts',
    readFileSync(new URL('../index.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  let callback: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'app.get' &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === '/api/chat/events'
    )
      callback = node.arguments[1];
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!callback) throw Error('SSE events route not found');
  const code = ts.transpileModule(`(${callback.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return runInNewContext(code, dependencies) as (req: Request, res: Response) => void;
}

it('negotiates bounded ACK batches through the actual SSE welcome frame', async () => {
  const streams = new SessionSseRegistry();
  const connections = new ConnectionRegistry();
  const request = new EventEmitter();
  const frames: string[] = [];
  const response = {
    locals: {},
    writeHead: vi.fn(),
    write: (frame: string) => frames.push(frame),
    writableEnded: false,
  } as unknown as Response;
  const events = new EventTarget();
  const source = Object.assign(events, { close: vi.fn(), onmessage: null });
  const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<globalThis.Response>>(async () =>
    globalThis.Response.json({ applied: true }),
  );
  const client = new SseConnection({
    baseUrl: 'https://offline.invalid',
    fetch,
    createEventSource: () => source as unknown as EventSource,
  });
  client.onMessage(() => true);
  try {
    eventsRoute({
      SseTransport,
      chatSseRegistry: streams,
      connRegistry: connections,
      registry: { removeObserver: vi.fn() },
      withSpan: (_name: string, _attrs: unknown, fn: () => void) => fn(),
      log: { info: vi.fn() },
    })(request as Request, response);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatch(/^event: welcome\ndata: /);
    const welcome = JSON.parse(frames[0].split('\ndata: ')[1]);
    client.connect();
    events.dispatchEvent(new MessageEvent('welcome', { data: JSON.stringify(welcome) }));
    expect(client.isConnected()).toBe(true);
    for (let seq = 1; seq <= 100; seq++) {
      (source as unknown as EventSource).onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'block_delta',
            sessionId: 'session',
            seq,
            prevSessionSeq: seq - 1,
            delta: 'text',
          }),
        }),
      );
    }
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(fetch.mock.calls.map(([, init]) => JSON.parse(init!.body as string).seqs)).toEqual([
      Array.from({ length: 50 }, (_, i) => i + 1),
      Array.from({ length: 50 }, (_, i) => i + 51),
    ]);
  } finally {
    client.disconnect();
    request.emit('close');
    streams.destroy();
  }
});
