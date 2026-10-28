import express, { type Express } from 'express';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { createServer as createViteServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium, type Browser, type Page, type BrowserContextOptions } from '@playwright/test';
import { ConnectionRegistry } from '@mitzo/harness';
import type { SessionSseRegistry } from '../../../../server/session-sse-registry.js';
import type { AuthSession } from '../../../../server/auth.js';
import type * as Chat from '../../../../server/chat.js';

/** Test-only extraction of index.ts's ordinary SSE/REST composition. All registry,
 * authentication, reconnection, command and admission owners remain production
 * implementations. index.ts itself is never run: it installs host services.
 */
export async function installJoinedChatTransport(
  app: Express,
  chat: typeof Chat,
  streams: SessionSseRegistry,
) {
  const [
    { NativeCommandRegistry },
    { SseTransport },
    { createChatRestRouter },
    { createOwnedOrdinaryWorkspaceCommandRouter },
    { bindAgentLibraryTransport },
    { claimTransportConnection, releaseTransportConnection },
    { registerAuthSession },
  ] = await Promise.all([
    import('../../../../server/native-commands.js'),
    import('../../../../server/sse-transport.js'),
    import('../../../../server/chat-rest-handler.js'),
    import('../../../../server/ordinary-local-codex-entry.js'),
    import('../../../../server/agent-library-transport.js'),
    import('../../../../server/transport-auth-ownership.js'),
    import('../../../../server/auth.js'),
  ]);
  const connections = new ConnectionRegistry();
  chat.setConnectionRegistry(connections);
  const ctx = {
    connRegistry: connections,
    sessionRegistry: chat.registry,
    eventStore: chat.eventStore,
    nativeCommands: new NativeCommandRegistry(),
  };
  app.get('/api/chat/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const id = 's9-browser-' + randomUUID();
    const transport = new SseTransport(id, streams);
    const auth = res.locals.authSession as AuthSession | undefined;
    streams.add(id, res, auth?.id);
    const releaseLibrary = auth ? bindAgentLibraryTransport(id, auth) : () => {};
    if (auth) claimTransportConnection(id, auth.id);
    connections.register(id, transport);
    let cleaned = false;
    let unregister = () => {};
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      releaseLibrary();
      unregister();
      if (auth) releaseTransportConnection(id, auth.id);
      const watched = [...(connections.get(id)?.watchedSessions ?? [])];
      streams.remove(id);
      connections.remove(id);
      chat.registry.removeObserver(transport);
      for (const sessionId of watched) {
        const found = chat.registry.findBySessionId(sessionId);
        if (found && !chat.registry.isSuspended(found.clientId))
          chat.detachChatIfCurrentTransport(found.clientId, transport);
      }
    };
    req.on('close', cleanup);
    unregister = auth
      ? registerAuthSession(auth, (reason) => {
          streams.sendTo(id, { type: 'auth_expired', reason });
          res.end();
          cleanup();
        })
      : () => {};
    if (cleaned) {
      unregister();
      return;
    }
    streams.sendTo(id, {
      type: 'welcome',
      protocolVersion: 2,
      connectionId: id,
      eventAckBatchSize: 50,
    });
  });
  app.use('/api/chat', createChatRestRouter(streams, ctx));
  app.use(
    '/api/ordinary/workspaces/commands',
    createOwnedOrdinaryWorkspaceCommandRouter(streams, ctx),
  );
  return connections;
}

/** Actual frontend entry and routes, served on demand by Vite. A test-private
 * cache prevents writes to shared dependencies. All /api traffic is handled by
 * the actual Express app on this same ephemeral listener; no API fulfilment.
 * This focused development-entry journey is not production-bundle/reload or
 * pixel-equivalence acceptance.
 */
export async function createJoinedFrontend(app: Express, privateRoot: string) {
  const root = resolve('.');
  const vite = await createViteServer({
    configFile: false,
    root: join(root, 'frontend'),
    cacheDir: join(privateRoot, 'vite-cache'),
    plugins: [react()],
    resolve: {
      alias: [
        {
          find: '@mitzo/client/hooks',
          replacement: join(root, 'packages/client/src/hooks/index.ts'),
        },
        { find: '@mitzo/client', replacement: join(root, 'packages/client/src/index.ts') },
        { find: '@mitzo/protocol', replacement: join(root, 'packages/protocol/src/index.ts') },
      ],
    },
    server: {
      hmr: false,
      middlewareMode: true,
      fs: { allow: [root, resolve('node_modules'), privateRoot] },
    },
  });
  // Finish cold development transforms before the browser acceptance deadline.
  // Import analysis skips dynamic imports, so include the actual lazy chat route.
  // Errors remain startup failures; the browser still mounts the real app and
  // performs its fresh exact role review within the unchanged ten-second phase.
  try {
    await Promise.all([
      vite.transformRequest('/src/main.tsx'),
      vite.transformRequest('/src/components/ResponsiveChatView.tsx'),
    ]);
    await vite.waitForRequestsIdle();
  } catch (error) {
    await vite.close();
    throw error;
  }
  const front = express();
  front.use((req, res, next) =>
    req.path.startsWith('/api') || req.path.startsWith('/ws') ? app(req, res, next) : next(),
  );
  front.use(vite.middlewares);
  const server = createServer(front);
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  if (!address || typeof address === 'string' || [3100, 3101, 3190].includes(address.port))
    throw Error('Private joined test listener required');
  return {
    server,
    port: address.port,
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      await vite.close();
      await new Promise<void>((done, reject) => server.close((e) => (e ? reject(e) : done())));
    },
  };
}

export async function createJoinedBrowser(
  origin: string,
  token: string,
  options: BrowserContextOptions = {},
) {
  const browser: Browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
    ...options,
  });
  await context.addCookies([{ name: 'cc_auth', value: token, url: origin }]);
  // Abort third-party traffic only. Every owned HTTP/SSE endpoint stays real.
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin
      ? route.continue()
      : route.abort('blockedbyclient'),
  );
  const page: Page = await context.newPage();
  return { browser, context, page };
}
