import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { createVoiceProxy } from '../voice-proxy.js';
const servers: Server[] = [];
const clients: WebSocket[] = [];
async function listen(server: Server) {
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  clients.forEach((client) => client.terminate());
  clients.length = 0;
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
it('preserves the voice HTTP path, query, raw body and target host', async () => {
  const upstream = await listen(
    createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ url: req.url, body, host: req.headers.host }));
      });
    }),
  );
  const proxy = createVoiceProxy(upstream, '/api/yapper');
  const address = await listen(createServer(proxy.http));
  const result = await fetch(address + '/api/yapper/v1/synthesize?voice=a', {
    method: 'POST',
    body: 'raw voice input',
  });
  expect(await result.json()).toEqual({
    url: '/v1/synthesize?voice=a',
    body: 'raw voice input',
    host: new URL(upstream).host,
  });
  proxy.close();
});
it('forwards WebSocket upgrades, strips only the exact prefix and preserves frames', async () => {
  let upstreamPath = '';
  const upstreamServer = createServer();
  const wss = new WebSocketServer({ noServer: true });
  upstreamServer.on('upgrade', (req, socket, head) => {
    upstreamPath = req.url!;
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data) => ws.send(data));
    });
  });
  const upstream = await listen(upstreamServer);
  const proxy = createVoiceProxy(upstream, '/api/yapper-ws');
  const front = createServer(proxy.http);
  front.on('upgrade', proxy.upgrade);
  const address = await listen(front);
  const client = new WebSocket(
    address.replace('http:', 'ws:') + '/api/yapper-ws/v1/stream?session=a',
  );
  clients.push(client);
  await once(client, 'open');
  const received = once(client, 'message');
  client.send('voice frame');
  expect((await received)[0].toString()).toBe('voice frame');
  expect(upstreamPath).toBe('/v1/stream?session=a');
  client.terminate();
  await once(client, 'close');
  wss.clients.forEach((socket) => socket.terminate());
  wss.close();
  proxy.close();
});
it('returns a bounded 502 when the voice service is unavailable', async () => {
  const temporary = createServer();
  const closed = await listen(temporary);
  await new Promise<void>((resolve) => temporary.close(() => resolve()));
  const proxy = createVoiceProxy(closed, '/api/yapper');
  const address = await listen(createServer(proxy.http));
  const result = await fetch(address + '/api/yapper/health');
  expect(result.status).toBe(502);
  expect(await result.text()).toBe('Voice service unavailable.');
  proxy.close();
});
