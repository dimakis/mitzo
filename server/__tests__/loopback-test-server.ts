import { createServer, type RequestListener, type Server } from 'node:http';

/** Supertest connects to 127.0.0.1; bind that same address to own its endpoint.
 * A wildcard listener can coexist with another IPv4 listener on macOS. */
export function listenOnLoopback(listener: RequestListener): Promise<Server> {
  const server = createServer(listener);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

export function closeTestServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
