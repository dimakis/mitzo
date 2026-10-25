import type { Express } from 'express';
import { createServer } from 'node:http';
import { chromium, type Browser, type Page, type BrowserContextOptions } from '@playwright/test';
import { ConnectionRegistry } from '@mitzo/harness';
import type { SessionSseRegistry } from '../../../../server/session-sse-registry.js';
import type * as Chat from '../../../../server/chat.js';

/** Invoke the accepted production G1 installer with actual App-owned stores.
 * This candidate differs from the retained extracted-transport witness only in
 * registration: no manual event stream, auth cleanup, route or welcome frame.
 * index.ts is never imported because it starts host services.
 */
export async function installJoinedChatTransport(
  app: Express,
  chat: typeof Chat,
  streams: SessionSseRegistry,
) {
  const [{ NativeCommandRegistry }, { mountApplicationChatTransport }] = await Promise.all([
    import('../../../../server/native-commands.js'),
    import('../../../../server/chat-rest-handler.js'),
  ]);
  const connections = new ConnectionRegistry();
  chat.setConnectionRegistry(connections);
  mountApplicationChatTransport(app, streams, {
    connRegistry: connections,
    sessionRegistry: chat.registry,
    eventStore: chat.eventStore,
    nativeCommands: new NativeCommandRegistry(),
  });
  return connections;
}

/** Serve only the real App's original static frontend owner, or a transparent
 * forwarding App for the original cold-process fixture. The matching official
 * CI frontend/dist bytes must be independently qualified and installed before
 * any invocation; this helper never builds, rewrites or serves a Vite overlay.
 */
export async function createJoinedFrontend(app: Express, privateRoot: string) {
  void privateRoot;
  const server = createServer(app);
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
