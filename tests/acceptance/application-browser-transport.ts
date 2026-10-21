import { createServer } from 'node:http';
import type { Express } from 'express';
import { EventSource } from 'eventsource';
import supertest from 'supertest';

// Capture the platform implementation before the fixture forbids external fetch.
// The only network destination below is this disposable application's loopback socket.
const platformFetch = globalThis.fetch;

/** Actual HTTP and EventSource platform adapter. It never invents an SSE event,
 * welcome identity, connected state, cookie, registry entry or application reply.
 * Use the locked EventSource implementation for framing/reconnect/abort semantics.
 */
export async function createApplicationBrowserTransport(
  app: Express,
  readCookie: () => string,
  assets: ReadonlyMap<string, { contentType: string; bytes: Uint8Array | string }> = new Map(),
) {
  for (const path of assets.keys())
    if (path.startsWith('/api/')) throw Error('Browser assets cannot replace application APIs');
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://acceptance.invalid').pathname;
    const asset = request.method === 'GET' ? assets.get(path) : undefined;
    if (asset) {
      response.writeHead(200, { 'Content-Type': asset.contentType, 'Cache-Control': 'no-store' });
      response.end(asset.bytes);
    } else app(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Missing loopback address');
  const base = `http://127.0.0.1:${address.port}`;
  const streams = new Set<EventSource>();
  const streamRequests: Array<{
    path: string;
    hasCookie: boolean;
    signal: AbortSignal | undefined;
    status?: number;
    contentType?: string | null;
  }> = [];
  let closed = false;
  function streamPath(input: string | URL) {
    const url = new URL(input, 'http://acceptance.invalid');
    if (
      url.origin !== 'http://acceptance.invalid' ||
      !['/api/chat/events', '/api/events'].includes(url.pathname) ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      throw Error('Unexpected application EventSource URL');
    return url.pathname;
  }
  class ApplicationEventSource extends EventSource {
    constructor(input: string | URL) {
      if (closed) throw Error('Application browser transport is closed');
      const path = streamPath(input);
      super(`http://acceptance.invalid${path}`, {
        withCredentials: true,
        fetch: async (url, init) => {
          const path = streamPath(String(url));
          const headers = new Headers(init?.headers);
          const cookie = readCookie();
          if (cookie) headers.set('Cookie', cookie);
          headers.set('Host', 'acceptance.invalid');
          const record = { path, hasCookie: !!cookie, signal: init?.signal };
          streamRequests.push(record);
          const response = await platformFetch(`${base}${path}`, {
            ...init,
            headers,
            redirect: 'error',
          });
          // EventSource aborts fetch but does not cancel its locked body reader.
          // Forward abort to that same native reader, as the original HTTP
          // fixture does; preserve the Response, bytes and real SSE parser.
          const body = response.body;
          const signal = init?.signal;
          if (body && signal) {
            const getReader = body.getReader;
            Object.defineProperty(body, 'getReader', {
              configurable: true,
              value: (...args: unknown[]) => {
                const reader = Reflect.apply(
                  getReader,
                  body,
                  args,
                ) as ReadableStreamDefaultReader<Uint8Array>;
                Reflect.deleteProperty(body, 'getReader');
                const cancel = () => void reader.cancel(signal.reason).catch(() => undefined);
                if (signal.aborted) cancel();
                else signal.addEventListener('abort', cancel, { once: true });
                return reader;
              },
            });
          }
          Object.assign(record, {
            status: response.status,
            contentType: response.headers.get('content-type'),
          });
          return response;
        },
      });
      streams.add(this);
    }

    override close() {
      super.close();
      streams.delete(this);
    }
  }
  return {
    baseUrl: base,
    EventSource: ApplicationEventSource,
    streamRequests,
    async request(
      method: string,
      path: string,
      input: { body?: unknown; headers?: Record<string, string> } = {},
    ) {
      if (closed) throw Error('Application browser transport is closed');
      const client = supertest(server);
      const operation =
        method === 'GET'
          ? client.get(path)
          : method === 'POST'
            ? client.post(path)
            : method === 'PUT'
              ? client.put(path)
              : method === 'DELETE'
                ? client.delete(path)
                : undefined;
      if (!operation) throw Error('Unsupported application test HTTP method');
      operation.set(input.headers ?? {});
      if (input.body !== undefined) operation.type('json').send(JSON.stringify(input.body));
      const response = await operation.timeout(10000);
      return { status: response.status, body: response.body, headers: response.headers };
    },
    async close() {
      closed = true;
      for (const stream of streams) stream.close();
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
