import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import request from 'supertest';
import { closeTestServer, listenOnLoopback } from './loopback-test-server.js';

it('keeps Supertest requests on the fixture when another IPv4 listener tries its port', async () => {
  const fixture = await listenOnLoopback((_req, res) => res.end('fixture'));
  const other = createServer((_req, res) => res.writeHead(501).end('foreign server'));
  try {
    const { port } = fixture.address() as AddressInfo;
    const bindResult = await new Promise<string>((resolve) => {
      other.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'unknown'));
      other.listen(port, '127.0.0.1', () => resolve('listening'));
    });
    expect(bindResult).toBe('EADDRINUSE');
    const response = await request(fixture).get('/');
    expect(response.status).toBe(200);
    expect(response.text).toBe('fixture');
  } finally {
    if (other.listening) await closeTestServer(other);
    await closeTestServer(fixture);
  }
});
