import 'dotenv/config';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { verifyWsAuth } from './auth.js';
import {
  startChat,
  sendToChat,
  interruptChat,
  stopChat,
  detachChat,
  reattachChat,
  isActive,
  BASE_REPO,
  registry,
} from './chat.js';
import { cleanupStaleWorktrees } from './worktree.js';
import { HEARTBEAT_INTERVAL_MS, PORT_DEFAULT, SHUTDOWN_GRACE_MS } from './constants.js';
import { createLogger } from './logger.js';
import { app, setUpdateBroadcast, runUpdateCheck } from './app.js';

const log = createLogger('server');

const PORT = parseInt(process.env.PORT || String(PORT_DEFAULT), 10);

// WebSocket for chat
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

setUpdateBroadcast(() => {
  const msg = JSON.stringify({ type: 'update_available' });
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) client.send(msg);
  });
});

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
    const clientId = `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    log.info('chat connected', { clientId });
    handleChatWs(ws, clientId);
  });
});

function handleChatWs(ws: WebSocket, initialClientId: string) {
  let clientId = initialClientId;
  ws.send(JSON.stringify({ type: 'client_id', clientId }));

  const heartbeat = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'reattach' && msg.clientId) {
        const oldClientId = msg.clientId as string;
        const ok = reattachChat(oldClientId, ws);
        if (ok) {
          clientId = oldClientId;
          const session = registry.get(clientId);
          ws.send(
            JSON.stringify({
              type: 'reattached',
              clientId: oldClientId,
              sessionId: session?.sessionId,
              running: true,
            }),
          );
          if (session?.currentSnapshot) {
            ws.send(
              JSON.stringify({
                v: 2,
                type: 'message_snapshot',
                ts: Date.now(),
                messageId: session.currentSnapshot.messageId,
                blocks: session.currentSnapshot.blocks,
              }),
            );
          }
          log.info('reattached', { oldClientId, newClientId: initialClientId });
        } else {
          ws.send(
            JSON.stringify({
              type: 'reattach_failed',
              clientId: oldClientId,
              reason: 'Session not found or already finished',
            }),
          );
        }
        return;
      }

      if (msg.type === 'send' && msg.prompt) {
        if (isActive(clientId)) {
          sendToChat(clientId, msg.prompt, msg.images);
        } else {
          startChat(ws, clientId, msg.prompt, {
            resume: msg.resume,
            cwd: msg.cwd,
            model: msg.model,
            extraTools: msg.extraTools,
            mode: msg.mode,
            worktree: msg.worktree,
            images: msg.images,
          });
        }
      } else if (msg.type === 'interrupt' && msg.prompt) {
        interruptChat(clientId, msg.prompt, msg.images);
      } else if (msg.type === 'stop') {
        stopChat(clientId);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      log.warn('failed to handle WS message', { clientId, error: message });
      ws.send(JSON.stringify({ type: 'error', error: message }));
    }
  });

  ws.on('close', (code, reason) => {
    clearInterval(heartbeat);
    log.info('chat disconnected', { clientId, code, reason: reason?.toString() });
    if (isActive(clientId)) {
      detachChat(clientId);
      log.info('session detached (surviving)', { clientId });
    }
  });

  ws.on('error', (err) => {
    log.error('ws error', { clientId, error: err.message });
  });
}

function shutdown(signal: string) {
  log.info(`${signal} received — shutting down gracefully`);
  server.close();
  registry.dispose();
  for (const client of wss.clients) {
    client.close(1001, 'Server shutting down');
  }
  setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

import { checkPort } from './port-check.js';

checkPort(PORT).then((inUse) => {
  if (inUse) {
    log.error(`Port ${PORT} already in use. Another Mitzo instance may be running.`);
    log.error('Kill it or set a different PORT in .env.');
    process.exit(1);
  }

  server.listen(PORT, () => {
    log.info(`Chat Agent running on http://localhost:${PORT}`);
    try {
      cleanupStaleWorktrees(BASE_REPO);
    } catch (err: unknown) {
      log.warn('stale worktree cleanup failed (will retry on next restart)', {
        error: err instanceof Error ? err.message : 'unknown',
      });
    }

    const UPDATE_CHECK_INTERVAL_MS = 2 * 60 * 1000;
    setInterval(runUpdateCheck, UPDATE_CHECK_INTERVAL_MS);
  });
});
