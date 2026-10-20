import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { ConnectionRegistry } from '@mitzo/harness';
import { expect, it, vi } from 'vitest';
import { listenOnLoopback, closeTestServer } from './loopback-test-server.js';

it('uses real authenticated HTTP welcome, original library ownership, abort and revocation cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mitzo-chat-stream-'));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', join(root, 'private'));
  vi.stubEnv('MITZO_INTERNAL_TOKEN_PATH', join(root, 'internal-token'));
  await mkdir(join(root, '.mitzo'));
  const auth = await import('../auth.js');
  const { EventStore } = await import('../event-store.js');
  const store = new EventStore(join(root, '.mitzo', 'events.db'));
  auth.setAuthRevocationStore(store);
  const { mountApplicationChatEventStream } = await import('../chat-event-stream.js');
  const { SessionSseRegistry } = await import('../session-sse-registry.js');
  const { registry } = await import('../chat.js');
  const { captureAgentLibraryAuthorization } = await import('../agent-library-transport.js');
  const { liveTransportAuthSessionId, isTransportConnectionOwnedBy } =
    await import('../transport-auth-ownership.js');
  const streams = new SessionSseRegistry();
  const connections = new ConnectionRegistry();
  const app = express();
  app.use(cookieParser());
  app.use('/api', auth.authMiddleware);
  mountApplicationChatEventStream(app, streams, {
    connRegistry: connections,
    sessionRegistry: registry,
  });
  const server = await listenOnLoopback(app);
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Expected test loopback address');
  const url = `http://127.0.0.1:${address.port}/api/chat/events`;
  const controllers: AbortController[] = [];
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const decode = new TextDecoder();
  async function connect() {
    const token = (await auth.login(process.env.AUTH_PASSPHRASE!))!;
    const actor = (await auth.authenticateToken(token))!;
    const controller = new AbortController();
    controllers.push(controller);
    const response = await fetch(url, {
      headers: { Cookie: `cc_auth=${token}` },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    readers.push(reader);
    const frame = decode.decode((await reader.read()).value);
    expect(frame).toMatch(/^event: welcome\ndata: /);
    const welcome = JSON.parse(frame.split('\ndata: ')[1]);
    expect(welcome).toMatchObject({ type: 'welcome', protocolVersion: 2, eventAckBatchSize: 50 });
    expect(welcome.connectionId).toMatch(/^conn-/);
    expect(streams.isOwnedBy(welcome.connectionId, actor.id)).toBe(true);
    expect(connections.get(welcome.connectionId)).toBeDefined();
    expect(captureAgentLibraryAuthorization(welcome.connectionId).auth).toEqual(actor);
    expect(liveTransportAuthSessionId(welcome.connectionId)).toBe(actor.id);
    return { actor, controller, reader, id: welcome.connectionId as string };
  }
  function assertReleased(id: string) {
    expect(streams.has(id)).toBe(false);
    expect(connections.get(id)).toBeUndefined();
    expect(liveTransportAuthSessionId(id)).toBeUndefined();
    expect(() => captureAgentLibraryAuthorization(id)).toThrow(
      'Interactive operator authentication',
    );
  }
  try {
    expect((await fetch(url)).status).toBe(401);
    expect(streams.size).toBe(0);
    const first = await connect();
    first.controller.abort();
    await first.reader.cancel().catch(() => undefined);
    await vi.waitFor(() => assertReleased(first.id));
    // Preserve the original brief teardown lease, while live authority is gone.
    expect(isTransportConnectionOwnedBy(first.id, first.actor.id)).toBe(true);
    const second = await connect();
    expect(second.id).not.toBe(first.id);
    auth.revokeAuthSession(second.actor);
    const expired = decode.decode((await second.reader.read()).value);
    expect(expired).toContain('"type":"auth_expired"');
    await vi.waitFor(() => assertReleased(second.id));
    expect(store.isAuthSessionRevoked(second.actor)).toBe(true);
    expect(streams.size).toBe(0);
  } finally {
    controllers.forEach((controller) => controller.abort());
    await Promise.all(readers.map((reader) => reader.cancel().catch(() => undefined)));
    streams.destroy();
    server.closeAllConnections();
    await closeTestServer(server);
    store.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
