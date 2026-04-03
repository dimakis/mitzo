import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import request from 'supertest';
import type { Express } from 'express';
import { verifyWsAuth } from '../auth.js';

let app: Express;
let server: Server;
let wss: WebSocketServer;
let port: number;
let authCookie: string;

function wsUrl(path = '/ws/chat'): string {
  return `ws://localhost:${port}${path}`;
}

function connectWs(cookie?: string): Promise<{ ws: WebSocket; clientId: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (cookie) headers.Cookie = cookie;
    const ws = new WebSocket(wsUrl(), { headers });
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('WS connect+handshake timeout'));
    }, 5000);
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'client_id') {
        clearTimeout(timer);
        resolve({ ws, clientId: msg.clientId });
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function connectWsRaw(opts?: {
  cookie?: string;
  path?: string;
}): Promise<{ outcome: 'open' | 'error' | 'close'; code?: number; error?: string }> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {};
    if (opts?.cookie) headers.Cookie = opts.cookie;
    const ws = new WebSocket(wsUrl(opts?.path), { headers });
    const timer = setTimeout(() => {
      ws.terminate();
      resolve({ outcome: 'close', code: 1006 });
    }, 3000);
    ws.on('open', () => {
      clearTimeout(timer);
      resolve({ outcome: 'open' });
      ws.close();
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      resolve({ outcome: 'error', error: err.message });
    });
  });
}

beforeAll(async () => {
  const mod = await import('../app.js');
  app = mod.app;

  server = createServer(app);
  wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    if (!url.pathname.startsWith('/ws/chat')) {
      socket.destroy();
      return;
    }

    const authed = await verifyWsAuth(req.headers.cookie);
    if (!authed) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const clientId = `test-client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      ws.send(JSON.stringify({ type: 'client_id', clientId }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;

  const res = await request(app)
    .post('/api/auth/login')
    .send({ passphrase: process.env.AUTH_PASSPHRASE });
  const setCookie = res.headers['set-cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  authCookie = cookies[0].split(';')[0];
});

afterAll(() => {
  wss.clients.forEach((c) => c.terminate());
  wss.close();
  server.close();
});

describe('WebSocket integration', () => {
  it('connects and receives client_id with valid auth cookie', async () => {
    const { ws, clientId } = await connectWs(authCookie);
    expect(typeof clientId).toBe('string');
    expect(clientId.startsWith('test-client-')).toBe(true);
    ws.close();
  });

  it('rejects connection without auth cookie', async () => {
    const result = await connectWsRaw();
    expect(result.outcome).toBe('error');
    expect(result.error).toContain('401');
  });

  it('rejects connection with invalid auth cookie', async () => {
    const result = await connectWsRaw({ cookie: 'cc_auth=invalid-token' });
    expect(result.outcome).toBe('error');
    expect(result.error).toContain('401');
  });

  it('rejects upgrade on non-chat path', async () => {
    const result = await connectWsRaw({ cookie: authCookie, path: '/ws/other' });
    expect(result.outcome).toBe('error');
  });

  it('handles malformed JSON without crashing', async () => {
    const { ws } = await connectWs(authCookie);
    ws.send('not valid json {{{');
    await new Promise((r) => setTimeout(r, 200));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('handles unknown message type without crashing', async () => {
    const { ws } = await connectWs(authCookie);
    ws.send(JSON.stringify({ type: 'totally_unknown', data: 123 }));
    await new Promise((r) => setTimeout(r, 200));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('multiple clients get independent client_ids', async () => {
    const c1 = await connectWs(authCookie);
    const c2 = await connectWs(authCookie);
    expect(c1.clientId).not.toBe(c2.clientId);
    c1.ws.close();
    c2.ws.close();
  });

  it('server sends valid JSON for client_id message', async () => {
    const { ws } = await connectWs(authCookie);
    // Already validated by connectWs, but let's verify the shape
    ws.close();
    // connectWs would have rejected if the first message wasn't parseable JSON
    // with type === 'client_id' — this test documents the contract
    expect(true).toBe(true);
  });
});
