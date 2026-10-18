import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import type { Express, Request, Response } from 'express';
import supertest from 'supertest';

/** Real HTTP completion/cancellation for the actual-app journey. The listener
 * is disposable, loopback-only and never runs index.ts or provider services.
 * On this Mac run this fixture outside Seatbelt, just like owner supertest cases.
 */
export async function createApplicationHttpTransport(app: Express) {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    async request(
      method: string,
      path: string,
      input: { body?: unknown; headers?: Record<string, string> } = {},
    ): Promise<Awaited<ReturnType<typeof requestApplication>>> {
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
      operation.set('Host', 'acceptance.invalid').set(input.headers ?? {});
      if (input.body !== undefined) operation.type('json').send(JSON.stringify(input.body));
      const response = await operation.timeout(10000);
      return { status: response.status, body: response.body, headers: response.headers };
    },
    async close() {
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

/** Transport only: dispatches the actual application middleware, including auth,
 * and captures its headers. No router, authentication or JSON algorithm is faked.
 * Like the retained custodian HTTP adapter, this needs no listening socket.
 */
export async function requestApplication(
  app: Express,
  method: string,
  path: string,
  input: { body?: unknown; headers?: Record<string, string> } = {},
) {
  const request = new IncomingMessage(new Socket());
  // A deterministic peer address lets the real IP/rate-limit middleware run.
  Object.defineProperty(request.socket, 'remoteAddress', { value: '127.0.0.1' });
  request.method = method;
  request.url = path;
  const body = input.body === undefined ? '' : JSON.stringify(input.body);
  request.headers = {
    host: 'acceptance.invalid',
    ...(body
      ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }
      : {}),
    ...input.headers,
  };
  if (body) request.push(body);
  request.push(null);
  const response = new ServerResponse(request);
  let completed = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<{
      status: number;
      body: unknown;
      headers: ReturnType<ServerResponse['getHeaders']>;
    }>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, chunk?: unknown) => {
        if (settled) return;
        settled = true;
        if (error) {
          reject(error);
          return;
        }
        try {
          const text = Buffer.isBuffer(chunk)
            ? chunk.toString('utf8')
            : typeof chunk === 'string'
              ? chunk
              : '';
          if (Buffer.byteLength(text) > 1024 * 1024)
            throw Error('Application test response exceeds 1 MiB');
          completed = true;
          resolve({
            status: response.statusCode,
            body: text ? JSON.parse(text) : null,
            headers: response.getHeaders(),
          });
        } catch (error) {
          reject(error);
        }
      };
      timeout = setTimeout(() => finish(Error('Application request timed out')), 5000);
      response.end = ((chunk?: unknown) => {
        finish(undefined, chunk);
        return response;
      }) as typeof response.end;
      app(request as Request, response as Response, (error?: unknown) =>
        finish(error ?? Error('Application route unavailable')),
      );
    });
  } finally {
    clearTimeout(timeout);
    response.emit(completed ? 'finish' : 'close');
    request.destroy();
  }
}
