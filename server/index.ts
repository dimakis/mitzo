import 'dotenv/config';
import { existsSync, readFileSync } from 'fs';
import { createServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import type { Socket } from 'net';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { WsTransport } from './ws-transport.js';
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
  eventStore,
  getRepoConfig,
} from './chat.js';
import { cleanupStaleWorktrees } from './worktree.js';
import { HEARTBEAT_INTERVAL_MS, PORT_DEFAULT, SHUTDOWN_GRACE_MS } from './constants.js';
import { createLogger } from './logger.js';
import {
  app,
  setUpdateBroadcast,
  setInboxBroadcast,
  setTaskBroadcast,
  setOrchestrator,
  runUpdateCheck,
  buildSkillRegistry,
  NATIVE_COMMAND_NAMES,
  isAllowedPath,
  yapperWsProxy,
  taskStore,
} from './app.js';
import { TaskOrchestrator } from './task-orchestrator.js';
import { IncomingWsMessage } from './ws-schemas.js';
import { resolvePending } from './permissions.js';
import { resolveSlashCommand } from './slash-commands.js';
import { NativeCommandRegistry } from './native-commands.js';
import { setSkillPolicy, clearSkillPolicy } from './skill-policy.js';

const log = createLogger('server');

const PORT = parseInt(process.env.PORT || String(PORT_DEFAULT), 10);

const nativeCommands = new NativeCommandRegistry();

// Resolve cert paths relative to the project root (where package.json lives)
const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = join(__filename, '..', '..');
const CERT_PATH = join(PROJECT_ROOT, 'certs', 'cert.pem');
const KEY_PATH = join(PROJECT_ROOT, 'certs', 'key.pem');
const USE_TLS = existsSync(CERT_PATH) && existsSync(KEY_PATH);

// WebSocket for chat — use HTTPS when certs are available
const server = USE_TLS
  ? createHttpsServer({ cert: readFileSync(CERT_PATH), key: readFileSync(KEY_PATH) }, app)
  : createServer(app);
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

setUpdateBroadcast(() => {
  const msg = JSON.stringify({ type: 'update_available' });
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) client.send(msg);
  });
});

setInboxBroadcast(() => {
  const msg = JSON.stringify({ type: 'inbox_updated' });
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) client.send(msg);
  });
});

setTaskBroadcast((event) => {
  const msg = JSON.stringify(event);
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) client.send(msg);
  });
});

// --- Task Orchestrator ---
const orchestrator = new TaskOrchestrator({
  store: taskStore,
  getClientId: () => {
    // Find the first registered client (reuse-only for Phase 2)
    for (const [clientId] of registry.entries()) {
      if (registry.isAttached(clientId)) return clientId;
    }
    return null;
  },
  setTaskContext: (taskId, goalId) => {
    // Set task context on the pinned client's session
    const clientId = orchestrator.getPinnedClientId();
    if (clientId) {
      const session = registry.get(clientId);
      if (session) {
        session.taskContext = { currentTaskId: taskId, goalId };
      }
    }
  },
  clearTaskContext: () => {
    for (const [clientId] of registry.entries()) {
      const session = registry.get(clientId);
      if (session) session.taskContext = null;
    }
  },
  broadcastStatus: (status) => {
    const msg = JSON.stringify({ type: 'loop_status', ...status });
    wss.clients.forEach((client) => {
      if (client.readyState === client.OPEN) client.send(msg);
    });
  },
  broadcastTasks: () => {
    const tree = taskStore.getTree();
    const msg = JSON.stringify({ type: 'task_state', tasks: tree });
    wss.clients.forEach((client) => {
      if (client.readyState === client.OPEN) client.send(msg);
    });
  },
  getActiveSessionIds: () => {
    const ids = new Set<string>();
    for (const [clientId] of registry.entries()) {
      const session = registry.get(clientId);
      if (session?.sessionId) ids.add(session.sessionId);
    }
    return ids;
  },
});
setOrchestrator(orchestrator);

server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url || '', `http://${req.headers.host}`);

  // Yapper WebSocket proxy — no auth required (voice is local-only)
  if (url.pathname.startsWith('/api/yapper-ws')) {
    yapperWsProxy.upgrade(req, socket as Socket, head);
    return;
  }

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

/** Map raw WebSocket → WsTransport wrapper, so removeObserver can look up the transport. */
const transportMap = new Map<WebSocket, WsTransport>();

/**
 * Get or create a WsTransport wrapper for a raw WebSocket.
 * Ensures each WebSocket maps to exactly one transport instance.
 */
function getTransport(ws: WebSocket): WsTransport {
  let transport = transportMap.get(ws);
  if (!transport) {
    transport = new WsTransport(ws);
    transportMap.set(ws, transport);
  }
  return transport;
}

/**
 * If `resume` targets a session that's already active, subscribe the caller
 * as an observer and inject the message into the running session.
 * Returns the driver's clientId if handled, null to fall through to startChat.
 */
function tryRouteToActiveSession(
  ws: WebSocket,
  resume: string | undefined,
  prompt: string,
  images?: Array<{ data: string; mediaType: string }>,
  contextBlocks?: string[],
  clientMsgId?: string,
): string | null {
  if (!resume) return null;
  const found = registry.findBySessionId(resume);
  if (!found) return null;
  // Session is active — subscribe as observer instead of starting a duplicate query
  const transport = getTransport(ws);
  const driverId = registry.addObserver(resume, transport);
  if (!driverId) return null; // observer cap reached
  // Send snapshot so observer sees the current streaming state
  if (found.session.currentSnapshot) {
    transport.send({
      v: 2,
      type: 'message_snapshot',
      ts: Date.now(),
      messageId: found.session.currentSnapshot.messageId,
      blocks: found.session.currentSnapshot.blocks,
    });
  }
  sendToChat(found.clientId, prompt, images, contextBlocks, clientMsgId);
  log.info('routed observer message to active session', {
    sessionId: resume,
    driverClientId: found.clientId,
  });
  return found.clientId;
}

function handleChatWs(ws: WebSocket, initialClientId: string) {
  let clientId = initialClientId;
  const transport = getTransport(ws);
  transport.send({ type: 'client_id', clientId });

  // Hydrate task board state
  const taskTree = taskStore.getTree();
  transport.send({ type: 'task_state', tasks: taskTree });

  const heartbeat = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  ws.on('message', async (raw) => {
    try {
      const parsed = JSON.parse(raw.toString());
      const result = IncomingWsMessage.safeParse(parsed);

      if (!result.success) {
        log.debug('unrecognized WS message', { clientId, type: parsed?.type });
        return;
      }

      const msg = result.data;

      if (msg.type === 'subscribe') {
        const found = registry.findBySessionId(msg.sessionId);
        if (found && !registry.isAttached(found.clientId)) {
          // Driver WS is dead (session detached). Promote this subscriber
          // to the session driver so it receives direct query-loop events
          // instead of being a passive observer. This is the typical iOS
          // Safari reconnect path: the socket drops every 30-90s and the
          // pool reconnects with a subscribe carrying the session ID.
          const ok = reattachChat(found.clientId, transport);
          if (ok) {
            clientId = found.clientId;
            const session = registry.get(clientId);
            transport.send({
              type: 'reattached',
              clientId: found.clientId,
              sessionId: session?.sessionId,
              running: true,
            });
            // Replay missed events from the durable event store so the
            // client catches up on anything sent while the WS was dead.
            if (session?.sessionId && msg.lastSeq != null) {
              const missed = eventStore.getEventsAfter(session.sessionId, msg.lastSeq);
              for (const evt of missed) {
                if (evt.type === 'worktree_opened') {
                  const p = evt.payload as { path?: string; repoName?: string };
                  if (p.path && !existsSync(p.path)) continue;
                  if (p.path && p.repoName && session && !session.worktreePaths.has(p.repoName)) {
                    const match = p.path.match(/session-(wt-[^/]+)$/);
                    if (match) {
                      session.worktreePaths.set(p.repoName, { path: p.path, wtId: match[1] });
                    }
                  }
                }
                transport.send({ ...evt.payload, seq: evt.seq } as Record<string, unknown>);
              }
              log.info('subscribe-reattach replayed events', {
                clientId,
                sessionId: msg.sessionId,
                count: missed.length,
              });
            }
            if (session?.currentSnapshot) {
              transport.send({
                v: 2,
                type: 'message_snapshot',
                ts: Date.now(),
                messageId: session.currentSnapshot.messageId,
                blocks: session.currentSnapshot.blocks,
              });
            }
            log.info('subscribe promoted to reattach (detached session)', {
              clientId,
              sessionId: msg.sessionId,
            });
          } else {
            // Reattach failed — fall back to observer
            registry.addObserver(msg.sessionId, transport);
            transport.send({
              type: 'subscribed',
              sessionId: msg.sessionId,
              running: true,
            });
          }
        } else if (found) {
          // Driver is still attached (another client). Join as observer.
          registry.addObserver(msg.sessionId, transport);
          transport.send({
            type: 'subscribed',
            sessionId: msg.sessionId,
            running: true,
          });
          if (found.session.currentSnapshot) {
            transport.send({
              v: 2,
              type: 'message_snapshot',
              ts: Date.now(),
              messageId: found.session.currentSnapshot.messageId,
              blocks: found.session.currentSnapshot.blocks,
            });
          }
          log.info('client subscribed to active session', {
            clientId,
            sessionId: msg.sessionId,
          });
        } else {
          transport.send({
            type: 'subscribed',
            sessionId: msg.sessionId,
            running: false,
          });
        }
      } else if (msg.type === 'reattach') {
        const ok = reattachChat(msg.clientId, transport);
        if (ok) {
          clientId = msg.clientId;
          const session = registry.get(clientId);
          transport.send({
            type: 'reattached',
            clientId: msg.clientId,
            sessionId: session?.sessionId,
            running: true,
          });
          // Replay missed events from durable event store.
          if (session?.sessionId && msg.lastSeq != null) {
            const missed = eventStore.getEventsAfter(session.sessionId, msg.lastSeq);
            for (const evt of missed) {
              // Skip worktree_opened events whose paths were cleaned up (e.g. server restart)
              if (evt.type === 'worktree_opened') {
                const p = evt.payload as { path?: string; repoName?: string };
                if (p.path && !existsSync(p.path)) {
                  log.info('skipping stale worktree_opened event on reattach', { path: p.path });
                  continue;
                }
                // Re-populate in-memory worktreePaths for valid worktrees
                if (p.path && p.repoName && !session.worktreePaths.has(p.repoName)) {
                  const match = p.path.match(/session-(wt-[^/]+)$/);
                  if (match) {
                    session.worktreePaths.set(p.repoName, { path: p.path, wtId: match[1] });
                  }
                }
              }
              transport.send({ ...evt.payload, seq: evt.seq } as Record<string, unknown>);
            }
          }
          if (session?.currentSnapshot) {
            transport.send({
              v: 2,
              type: 'message_snapshot',
              ts: Date.now(),
              messageId: session.currentSnapshot.messageId,
              blocks: session.currentSnapshot.blocks,
            });
          }
          log.info('reattached', { oldClientId: msg.clientId, newClientId: initialClientId });
        } else {
          transport.send({
            type: 'reattach_failed',
            clientId: msg.clientId,
            reason: 'Session not found or already finished',
          });
        }
      } else if (msg.type === 'send') {
        // Resolve slash commands server-side before routing
        const rawCwd = msg.cwd || registry.get(clientId)?.cwd || BASE_REPO;
        const cwd = rawCwd && isAllowedPath(rawCwd) ? rawCwd : BASE_REPO;
        const skillRegistry = buildSkillRegistry(cwd);
        const resolution = resolveSlashCommand(msg.prompt, skillRegistry, NATIVE_COMMAND_NAMES);

        if (resolution.type === 'native') {
          // Native commands execute directly — never touch the SDK
          const result = nativeCommands.execute(
            resolution.name,
            resolution.arguments,
            skillRegistry,
          );
          if (result) {
            transport.send({
              type: 'native_command_result',
              v: 2,
              command: result.command,
              content: result.content,
            });
          }
        } else if (resolution.type === 'error') {
          transport.send({ type: 'error', error: resolution.message });
        } else if (resolution.type === 'skill') {
          // Set skill policy for tool restrictions
          if (resolution.allowedTools) {
            setSkillPolicy(registry, clientId, resolution.allowedTools);
          } else {
            clearSkillPolicy(registry, clientId);
          }

          // Emit skill_invoked event for frontend badging
          transport.send({
            type: 'skill_invoked',
            v: 2,
            name: resolution.name,
            source: skillRegistry.get(resolution.name)?.scope || 'bundled',
            arguments: resolution.arguments,
            ...(resolution.collisions ? { collisions: resolution.collisions } : {}),
          });

          // Pass rendered prompt through to normal chat flow
          if (isActive(clientId)) {
            sendToChat(
              clientId,
              resolution.renderedPrompt,
              msg.images,
              msg.contextBlocks,
              msg.clientMsgId,
            );
          } else if (
            !tryRouteToActiveSession(
              ws,
              msg.resume,
              resolution.renderedPrompt,
              msg.images,
              msg.contextBlocks,
              msg.clientMsgId,
            )
          ) {
            startChat(transport, clientId, resolution.renderedPrompt, {
              resume: msg.resume,
              cwd: msg.cwd,
              model: msg.model,
              extraTools: msg.extraTools,
              mode: msg.mode,
              images: msg.images,
              contextBlocks: msg.contextBlocks,
              clientMsgId: msg.clientMsgId,
            });
          }
        } else {
          // Passthrough — plain text, no slash command
          clearSkillPolicy(registry, clientId);
          if (isActive(clientId)) {
            sendToChat(clientId, msg.prompt, msg.images, msg.contextBlocks, msg.clientMsgId);
          } else if (
            !tryRouteToActiveSession(
              ws,
              msg.resume,
              msg.prompt,
              msg.images,
              msg.contextBlocks,
              msg.clientMsgId,
            )
          ) {
            startChat(transport, clientId, msg.prompt, {
              resume: msg.resume,
              cwd: msg.cwd,
              model: msg.model,
              extraTools: msg.extraTools,
              mode: msg.mode,
              images: msg.images,
              contextBlocks: msg.contextBlocks,
              clientMsgId: msg.clientMsgId,
            });
          }
        }
      } else if (msg.type === 'permission_response') {
        resolvePending(msg.permId, msg.decision || 'deny');
      } else if (msg.type === 'set_mode') {
        registry.setMode(clientId, msg.mode);
        const session = registry.get(clientId);
        if (session) {
          transport.send({ type: 'mode_changed', mode: msg.mode });
        }
      } else if (msg.type === 'interrupt') {
        interruptChat(clientId, msg.prompt, msg.images, msg.contextBlocks, msg.clientMsgId);
      } else if (msg.type === 'stop') {
        stopChat(clientId);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      log.warn('failed to handle WS message', { clientId, error: message });
      transport.send({ type: 'error', error: message });
    }
  });

  ws.on('close', (code, reason) => {
    clearInterval(heartbeat);
    registry.removeObserver(transport);
    transportMap.delete(ws);
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
    const protocol = USE_TLS ? 'https' : 'http';
    log.info(`Chat Agent running on ${protocol}://localhost:${PORT}${USE_TLS ? ' (TLS)' : ''}`);
    // Clean up stale worktrees across all repos.
    // Dirty worktrees (uncommitted work) are flagged in the mgmt inbox.
    const inboxDir = BASE_REPO ? join(BASE_REPO, 'mgmt_lib', 'inbox') : undefined;
    const repoEntries: [string, string][] = [['primary', BASE_REPO]];
    try {
      const config = getRepoConfig();
      repoEntries.push(...Object.entries(config.repos));
    } catch (err: unknown) {
      log.warn('failed to load repo config for worktree cleanup', {
        error: err instanceof Error ? err.message : 'unknown',
      });
    }
    for (const [label, repoPath] of repoEntries) {
      try {
        cleanupStaleWorktrees(repoPath, inboxDir);
      } catch (err: unknown) {
        log.warn(`stale worktree cleanup failed for ${label}`, {
          error: err instanceof Error ? err.message : 'unknown',
        });
      }
    }

    const UPDATE_CHECK_INTERVAL_MS = 2 * 60 * 1000;
    setInterval(runUpdateCheck, UPDATE_CHECK_INTERVAL_MS);
  });
});
