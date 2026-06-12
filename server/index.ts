import 'dotenv/config';
import dns from 'node:dns';

// Force IPv4-first DNS resolution. Works around undici's broken happy-eyeballs
// (RFC 8305) that fails to fall back from IPv6 on networks with Tailscale ULA.
dns.setDefaultResultOrder('ipv4first');

import './tracing.js';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { createServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import type { Socket } from 'net';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { WsTransport } from './ws-transport.js';
import { verifyWsAuth, verifyToken } from './auth.js';
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
  setConnectionRegistry,
  setSessionChangeCallback,
  setSessionsChangedCallback,
  reconcileSessionsBackground,
} from './chat.js';
import { cleanupStaleWorktrees, countWorktrees } from './worktree.js';
import { getWorktreeGuardStats, resetWorktreeGuardStats } from '@mitzo/harness';
import {
  HEARTBEAT_INTERVAL_MS,
  PORT_DEFAULT,
  SHUTDOWN_GRACE_MS,
  GUARD_STATS_INTERVAL_MS,
  WORKTREE_CLEANUP_INTERVAL_MS,
} from './constants.js';
import { createLogger } from './logger.js';
import {
  app,
  sseRegistry,
  setUpdateBroadcast,
  setInboxBroadcast,
  setTaskBroadcast,
  setWorkloadBroadcast,
  setOrchestrator,
  setTemplateStore,
  setSignalProcessor,
  setOverviewEmitter,
  setHealthMonitor,
  setSkillWatcher,
  runUpdateCheck,
  buildSkillRegistry,
  invalidateSkillRegistries,
  BUNDLED_SKILLS_DIR,
  USER_SKILLS_DIR,
  NATIVE_COMMAND_NAMES,
  isAllowedPath,
  yapperWsProxy,
  taskStore,
  workloadStore,
} from './app.js';
import { SkillWatcher } from './skill-watcher.js';
import { WorkflowTemplateStore, seedBuiltInTemplates } from './workflow-templates.js';
import { SignalProcessor } from './signal-processor.js';
import { TaskOrchestrator } from './task-orchestrator.js';
import { SessionOverviewEmitter } from './session-overview.js';
import { HealthMonitor } from './health-monitor.js';
import { IncomingWsMessage } from './ws-schemas.js';
import { resolvePending } from './permissions.js';
import { resolveSlashCommand } from './slash-commands.js';
import { NativeCommandRegistry } from './native-commands.js';
import { setSkillPolicy, clearSkillPolicy } from './skill-policy.js';
import { ConnectionRegistry } from '@mitzo/harness';
import {
  isHelloHandshake,
  handleHello,
  dispatchV2Message,
  type V2HandlerContext,
} from './ws-handler-v2.js';
import { withSpan, withSpanAsync } from './tracing.js';
import { contextFromTraceparent } from './trace-context.js';

const log = createLogger('server');

const PORT = parseInt(process.env.PORT || String(PORT_DEFAULT), 10);

const nativeCommands = new NativeCommandRegistry();
const connRegistry = new ConnectionRegistry();
setConnectionRegistry(connRegistry);

// Wire up EventStore for periodic sync (enables delivery guarantee).
// Provide isSessionActive so periodic sync skips ended sessions.
connRegistry.setEventStore({
  getEventsAfter: (sessionId, afterSeq, limit) =>
    eventStore.getEventsAfter(sessionId, afterSeq, limit),
  isSessionActive: (sessionId) => eventStore.getSession(sessionId)?.isActive ?? false,
});

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

// Declared early so broadcast closures can reference it safely (assigned after orchestrator init)
// eslint-disable-next-line prefer-const
let overviewEmitter: SessionOverviewEmitter;

setUpdateBroadcast(() => {
  const data = { type: 'update_available' };
  const msg = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (v2Sockets.has(client)) return;
    if (client.readyState === client.OPEN) client.send(msg);
  });
  connRegistry.broadcastAll(data);
  sseRegistry.broadcast('update_available', {});
});

setInboxBroadcast(() => {
  const data = { type: 'inbox_updated' };
  const msg = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (v2Sockets.has(client)) return;
    if (client.readyState === client.OPEN) client.send(msg);
  });
  connRegistry.broadcastAll(data);
  sseRegistry.broadcast('inbox_updated', {});
});

setTaskBroadcast((event) => {
  const msg = JSON.stringify(event);
  wss.clients.forEach((client) => {
    if (v2Sockets.has(client)) return;
    if (client.readyState === client.OPEN) client.send(msg);
  });
  connRegistry.broadcastAll(event as Record<string, unknown>);
  sseRegistry.broadcast('task_state', event);
  overviewEmitter.scheduleBroadcast();
});

setWorkloadBroadcast((event) => {
  const msg = JSON.stringify(event);
  wss.clients.forEach((client) => {
    if (v2Sockets.has(client)) return;
    if (client.readyState === client.OPEN) client.send(msg);
  });
  connRegistry.broadcastAll(event as Record<string, unknown>);
  sseRegistry.broadcast('todo_update', { action: 'refresh' });
});

// --- Workflow layer ---
const wfTemplateStore = new WorkflowTemplateStore(taskStore.getDatabase());
seedBuiltInTemplates(wfTemplateStore);
setTemplateStore(wfTemplateStore);

// SignalProcessor + orchestrator have a circular dep: signal resolution triggers tick(),
// tick() registers watches. Break the cycle with a late-bound callback.
let orchestratorRef: TaskOrchestrator | null = null;
const signalProc = new SignalProcessor(taskStore, () => {
  orchestratorRef?.tick();
});
setSignalProcessor(signalProc);

// --- Task Orchestrator ---
const orchestrator = new TaskOrchestrator({
  store: taskStore,
  workloadStore,
  watchSignal: (taskId, gateConfig) => signalProc.watch(taskId, gateConfig),
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
    const data = { type: 'loop_status', ...status };
    const msg = JSON.stringify(data);
    wss.clients.forEach((client) => {
      if (v2Sockets.has(client)) return;
      if (client.readyState === client.OPEN) client.send(msg);
    });
    connRegistry.broadcastAll(data);
    sseRegistry.broadcast('loop_status', status);
    overviewEmitter.scheduleBroadcast();
  },
  broadcastTasks: () => {
    const tree = taskStore.getTree();
    const data = { type: 'task_state', tasks: tree };
    const msg = JSON.stringify(data);
    wss.clients.forEach((client) => {
      if (v2Sockets.has(client)) return;
      if (client.readyState === client.OPEN) client.send(msg);
    });
    connRegistry.broadcastAll(data as Record<string, unknown>);
    sseRegistry.broadcast('task_state', data);
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
orchestratorRef = orchestrator;
setOrchestrator(orchestrator);

// --- Session Overview Emitter (SSE broadcast) ---
overviewEmitter = new SessionOverviewEmitter({
  registry,
  sseRegistry,
  getLoopStatus: () => orchestrator.getStatus(),
  taskStore,
  eventStore,
  getSessionTitle: (id: string) => eventStore.getSession(id)?.summary ?? undefined,
});
setOverviewEmitter(overviewEmitter);

// --- Health Monitor (SSE broadcast) ---
const healthMonitor = new HealthMonitor(sseRegistry);
setHealthMonitor(healthMonitor);
healthMonitor.start();

// Hook session lifecycle events into the overview emitter
setSessionChangeCallback((clientId, event, sessionId) => {
  if (event === 'start') {
    overviewEmitter.touch(clientId);
  } else if (event === 'end') {
    overviewEmitter.forget(clientId, sessionId);
  } else if (event === 'user_message') {
    const session = registry.get(clientId);
    if (session?.sessionId) {
      overviewEmitter.updateSpeaker(session.sessionId, 'user');
    }
  } else if (event === 'turn_end') {
    overviewEmitter.touch(clientId);
    // Mark assistant as last speaker for attention tracking
    const session = registry.get(clientId);
    if (session?.sessionId) {
      eventStore.updateLastSpeaker(session.sessionId, 'assistant');
      overviewEmitter.updateSpeaker(session.sessionId, 'assistant');
    }
  }
  overviewEmitter.scheduleBroadcast();
});

setSessionsChangedCallback(() => {
  sseRegistry.broadcast('sessions_changed', {});
});

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

  const authed =
    (await verifyWsAuth(req.headers.cookie)) ||
    (await verifyToken(url.searchParams.get('token') || ''));
  if (!authed) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    const connId = `conn-${crypto.randomUUID()}`;
    log.info('chat connected', { connectionId: connId });
    routeWsClient(ws, connId);
  });
});

/**
 * Route a new WebSocket to v1 or v2 protocol based on the first message.
 * v2 clients send { type: 'hello', protocolVersion: 2 } immediately.
 * v1 clients send a regular message (send, reattach, etc.).
 *
 * Dead sockets (no message within 1s) and invalid JSON are closed
 * immediately instead of falling through to v1. This prevents reconnect
 * storms from stale/dead connections consuming resources.
 */
function routeWsClient(ws: WebSocket, assignedId: string) {
  const HANDSHAKE_TIMEOUT_MS = 1_000;

  const timer = setTimeout(() => {
    ws.removeListener('message', onFirstMessage);
    log.info('no hello received, closing dead connection', { connectionId: assignedId });
    ws.close(4000, 'No hello received');
  }, HANDSHAKE_TIMEOUT_MS);

  const onFirstMessage = (raw: Buffer | ArrayBuffer | Buffer[]) => {
    clearTimeout(timer);
    ws.removeListener('message', onFirstMessage);

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      ws.close(4001, 'Invalid handshake');
      return;
    }

    if (isHelloHandshake(parsed)) {
      handleChatWsV2(ws, assignedId);
    } else {
      handleChatWs(ws, assignedId, raw);
    }
  };

  ws.on('message', onFirstMessage);
}

/** v2 handler context — shared across all v2 connections. */
const v2Ctx: V2HandlerContext = {
  connRegistry,
  sessionRegistry: registry,
  eventStore,
  nativeCommands,
};

/**
 * Handle a v2 WebSocket connection (after hello handshake detected).
 * connectionId is immutable for the lifetime of this WS — never changes.
 */
function handleChatWsV2(ws: WebSocket, connectionId: string) {
  const transport = getTransport(ws);
  v2Sockets.add(ws);
  handleHello(connectionId, transport, v2Ctx);

  const heartbeat = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping();
  }, HEARTBEAT_INTERVAL_MS);

  // Per-connection promise chain ensures FIFO ordering even when individual
  // dispatches are async (e.g. switch_session awaits SDK discovery).
  let dispatchChain = Promise.resolve();

  ws.on('message', (raw) => {
    dispatchChain = dispatchChain
      .then(() => dispatchV2Message(connectionId, transport, raw.toString(), v2Ctx))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Unknown error';
        log.warn('v2 message dispatch error', { connectionId, error: message });
        transport.send({ type: 'error', error: message });
      });
  });

  ws.on('close', (code, reason) => {
    clearInterval(heartbeat);
    v2Sockets.delete(ws);

    // Snapshot watched sessions before removing the connection — we need to
    // detach ALL sessions this connection was driving, not just the most recent.
    const conn = connRegistry.get(connectionId);
    const watchedSessions = conn ? [...conn.watchedSessions] : [];

    connRegistry.remove(connectionId);
    registry.removeObserver(transport);
    transportMap.delete(ws);
    log.info('v2 disconnected', { connectionId, code, reason: reason?.toString() });

    for (const sessionId of watchedSessions) {
      const found = registry.findBySessionId(sessionId);
      if (!found) continue;

      // If the session was proactively suspended (iOS backgrounding), the
      // WS close is expected — don't transition to detach. The suspend
      // grace timer manages the lifecycle instead.
      if (registry.isSuspended(found.clientId)) {
        log.info('v2 WS closed for suspended session (expected)', { connectionId, sessionId });
        continue;
      }

      const session = registry.get(found.clientId);
      if (session && session.transport === transport && registry.isAttached(found.clientId)) {
        withSpan(
          'session.detach',
          { 'session.sessionId': sessionId, 'ws.connectionId': connectionId },
          () => {
            detachChat(found.clientId);
            overviewEmitter.touch(found.clientId);
            overviewEmitter.scheduleBroadcast();
            log.info('v2 session detached (surviving)', { connectionId, sessionId });
          },
        );
      }
    }
  });

  ws.on('error', (err) => {
    log.error('v2 ws error', { connectionId, error: err.message });
  });
}

/** Map raw WebSocket → WsTransport wrapper, so removeObserver can look up the transport. */
const transportMap = new Map<WebSocket, WsTransport>();

/** v2 WebSockets — tracked so wss.clients broadcasts skip them (v2 gets events via connRegistry). */
const v2Sockets = new Set<WebSocket>();

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
 * Replay missed v2 events from the durable event store and send the
 * current snapshot if the session is still streaming. Used by both the
 * reattach handler and the subscribe-to-reattach promotion path.
 */
function replayMissedEvents(
  session: NonNullable<ReturnType<typeof registry.get>>,
  transport: WsTransport,
  lastSeq: number | undefined,
): number {
  if (!session.sessionId || lastSeq == null) return 0;
  const missed = eventStore.getEventsAfter(session.sessionId, lastSeq);
  for (const evt of missed) {
    if (evt.type === 'worktree_opened') {
      const p = evt.payload as { path?: string; repoName?: string };
      if (p.path && !existsSync(p.path)) continue;
      if (p.path && p.repoName && !session.worktreePaths.has(p.repoName)) {
        const match = p.path.match(/session-(wt-[^/]+)$/);
        if (match) {
          session.worktreePaths.set(p.repoName, { path: p.path, wtId: match[1] });
        }
      }
    }
    transport.send({ ...evt.payload, seq: evt.seq } as Record<string, unknown>);
  }
  return missed.length;
}

function sendSnapshot(
  session: NonNullable<ReturnType<typeof registry.get>>,
  transport: WsTransport,
): void {
  if (session.currentSnapshot) {
    transport.send({
      v: 2,
      type: 'message_snapshot',
      ts: Date.now(),
      messageId: session.currentSnapshot.messageId,
      blocks: session.currentSnapshot.blocks,
    });
  }
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

// v1 WS handler — no connection-level span. Per-handler spans (ws.send,
// ws.interrupt, etc.) provide sufficient tracing. v2 handlers in
// ws-handler-v2.ts are the primary path; this is legacy.
function handleChatWs(
  ws: WebSocket,
  initialClientId: string,
  bufferedMsg?: Buffer | ArrayBuffer | Buffer[],
) {
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

  const processMessage = async (raw: Buffer | ArrayBuffer | Buffer[]) => {
    try {
      const parsed = JSON.parse(raw.toString());
      const result = IncomingWsMessage.safeParse(parsed);

      if (!result.success) {
        log.debug('unrecognized WS message', { clientId, type: parsed?.type });
        return;
      }

      const msg = result.data;
      // traceparent is stripped by zod — extract from raw parsed object
      const traceparent = (parsed as Record<string, unknown>).traceparent as string | undefined;

      if (msg.type === 'subscribe') {
        withSpan(
          'ws.subscribe',
          { 'ws.client_id': clientId, 'ws.session_id': msg.sessionId },
          (span) => {
            const found = registry.findBySessionId(msg.sessionId);
            if (found && !registry.isAttached(found.clientId)) {
              const ok = reattachChat(found.clientId, transport);
              if (ok) {
                span.setAttribute('ws.subscribe.outcome', 'promoted_to_reattach');
                const session = registry.get(found.clientId);
                transport.send({
                  type: 'reattached',
                  clientId: found.clientId,
                  sessionId: session?.sessionId,
                  running: true,
                });
                if (session) {
                  const count = replayMissedEvents(session, transport, msg.lastSeq);
                  sendSnapshot(session, transport);
                  if (count > 0) {
                    log.info('subscribe-reattach replayed events', {
                      driverClientId: found.clientId,
                      sessionId: msg.sessionId,
                      count,
                    });
                    span.setAttribute('ws.replay.count', count);
                  }
                }
                log.info('subscribe promoted to reattach (detached session)', {
                  wsClientId: clientId,
                  driverClientId: found.clientId,
                  sessionId: msg.sessionId,
                });
              } else {
                span.setAttribute('ws.subscribe.outcome', 'observer_fallback');
                registry.addObserver(msg.sessionId, transport);
                transport.send({ type: 'subscribed', sessionId: msg.sessionId, running: true });
              }
            } else if (found) {
              span.setAttribute('ws.subscribe.outcome', 'observer');
              registry.addObserver(msg.sessionId, transport);
              transport.send({ type: 'subscribed', sessionId: msg.sessionId, running: true });
              sendSnapshot(found.session, transport);
              log.info('client subscribed to active session', {
                clientId,
                sessionId: msg.sessionId,
              });
            } else {
              span.setAttribute('ws.subscribe.outcome', 'not_found');
              transport.send({ type: 'subscribed', sessionId: msg.sessionId, running: false });
            }
          },
          contextFromTraceparent(traceparent),
        );
      } else if (msg.type === 'reattach') {
        withSpan(
          'ws.reattach',
          { 'ws.client_id': clientId, 'ws.reattach.target_client_id': msg.clientId },
          (span) => {
            const ok = reattachChat(msg.clientId, transport);
            if (ok) {
              span.setAttribute('ws.reattach.success', true);
              clientId = msg.clientId;
              const session = registry.get(clientId);
              transport.send({
                type: 'reattached',
                clientId: msg.clientId,
                sessionId: session?.sessionId,
                running: true,
              });
              if (session) {
                const count = replayMissedEvents(session, transport, msg.lastSeq);
                sendSnapshot(session, transport);
                span.setAttribute('ws.replay.count', count);
              }
              log.info('reattached', { oldClientId: msg.clientId, newClientId: initialClientId });
            } else {
              span.setAttribute('ws.reattach.success', false);
              transport.send({
                type: 'reattach_failed',
                clientId: msg.clientId,
                reason: 'Session not found or already finished',
              });
            }
          },
          contextFromTraceparent(traceparent),
        );
      } else if (msg.type === 'send') {
        withSpan(
          'ws.send',
          {
            'ws.client_id': clientId,
            'ws.client_msg_id': msg.clientMsgId ?? '',
            'ws.has_resume': !!msg.resume,
          },
          (span) => {
            const rawCwd = msg.cwd || registry.get(clientId)?.cwd || BASE_REPO;
            const cwd = rawCwd && isAllowedPath(rawCwd) ? rawCwd : BASE_REPO;
            const skillRegistry = buildSkillRegistry(cwd);
            const resolution = resolveSlashCommand(msg.prompt, skillRegistry, NATIVE_COMMAND_NAMES);
            span.setAttribute('ws.send.resolution', resolution.type);

            if (resolution.type === 'native') {
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
              if (resolution.allowedTools) {
                setSkillPolicy(registry, clientId, resolution.allowedTools);
              } else {
                clearSkillPolicy(registry, clientId);
              }
              transport.send({
                type: 'skill_invoked',
                v: 2,
                name: resolution.name,
                source: skillRegistry.get(resolution.name)?.scope || 'bundled',
                arguments: resolution.arguments,
                ...(resolution.collisions ? { collisions: resolution.collisions } : {}),
              });
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
                  isolation: msg.isolation,
                  mode: msg.mode,
                  images: msg.images,
                  contextBlocks: msg.contextBlocks,
                  clientMsgId: msg.clientMsgId,
                });
              }
            } else {
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
                  isolation: msg.isolation,
                  mode: msg.mode,
                  images: msg.images,
                  contextBlocks: msg.contextBlocks,
                  clientMsgId: msg.clientMsgId,
                });
              }
            }
          },
          contextFromTraceparent(traceparent),
        );
      } else if (msg.type === 'permission_response') {
        withSpan(
          'ws.permission_response',
          {
            'ws.client_id': clientId,
            'ws.perm_id': msg.permId,
            'ws.decision': msg.decision || 'deny',
          },
          () => {
            resolvePending(msg.permId, msg.decision || 'deny');
          },
          contextFromTraceparent(traceparent),
        );
      } else if (msg.type === 'set_mode') {
        withSpan(
          'ws.set_mode',
          { 'ws.client_id': clientId, 'ws.mode': msg.mode },
          () => {
            registry.setMode(clientId, msg.mode);
            const session = registry.get(clientId);
            if (session) {
              transport.send({ type: 'mode_changed', mode: msg.mode });
            }
          },
          contextFromTraceparent(traceparent),
        );
      } else if (msg.type === 'interrupt') {
        await withSpanAsync(
          'ws.interrupt',
          { 'ws.client_id': clientId, 'ws.client_msg_id': msg.clientMsgId ?? '' },
          async () => {
            await interruptChat(
              clientId,
              msg.prompt,
              msg.images,
              msg.contextBlocks,
              msg.clientMsgId,
            );
          },
          contextFromTraceparent(traceparent),
        );
      } else if (msg.type === 'stop') {
        withSpan(
          'ws.stop',
          { 'ws.client_id': clientId },
          () => {
            stopChat(clientId);
          },
          contextFromTraceparent(traceparent),
        );
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      log.warn('failed to handle WS message', { clientId, error: message });
      transport.send({ type: 'error', error: message });
    }
  };

  ws.on('message', processMessage);
  if (bufferedMsg) processMessage(bufferedMsg);

  ws.on('close', (code, reason) => {
    clearInterval(heartbeat);
    registry.removeObserver(transport);
    transportMap.delete(ws);
    log.info('chat disconnected', { clientId, code, reason: reason?.toString() });

    withSpan(
      'ws.disconnect',
      {
        'ws.client_id': clientId,
        'ws.close_code': code,
        'ws.close_reason': reason?.toString() || '',
      },
      (span) => {
        if (isActive(clientId)) {
          detachChat(clientId);
          overviewEmitter.touch(clientId);
          overviewEmitter.scheduleBroadcast();
          span.setAttribute('ws.disconnect.detached', true);
          log.info('session detached (surviving)', { clientId });
        }
      },
    );
  });

  ws.on('error', (err) => {
    log.error('ws error', { clientId, error: err.message });
  });
}

// --- Skill file watcher ---
// Ensure user skills directory exists so the watcher can monitor it from the
// start. Plugin installs write here, and the SKILL.md promises auto-reload.
mkdirSync(USER_SKILLS_DIR, { recursive: true });
const skillWatcher = new SkillWatcher(
  [BUNDLED_SKILLS_DIR, USER_SKILLS_DIR],
  invalidateSkillRegistries,
);
setSkillWatcher(skillWatcher);

function shutdown(signal: string) {
  log.info(`${signal} received — shutting down gracefully`);
  server.close();
  skillWatcher.destroy();
  signalProc.unwatchAll();
  wfTemplateStore.close();
  healthMonitor.destroy();
  overviewEmitter.destroy();
  sseRegistry.destroy();
  connRegistry.dispose(); // Stop periodic sync + clear state
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

  // Plain HTTP listener for watchOS (can't trust self-signed TLS certs)
  if (USE_TLS) {
    const httpServer = createServer(app);
    const HTTP_PORT = PORT + 1;
    httpServer.listen(HTTP_PORT, () => {
      log.info(`HTTP listener for watchOS on http://localhost:${HTTP_PORT}`);
    });
  }

  server.listen(PORT, () => {
    const protocol = USE_TLS ? 'https' : 'http';
    log.info(`Chat Agent running on ${protocol}://localhost:${PORT}${USE_TLS ? ' (TLS)' : ''}`);

    // Start periodic sync for connection-level delivery guarantee
    connRegistry.startPeriodicSync();

    // Eagerly reconcile sessions so the first /api/sessions request is fast and accurate.
    reconcileSessionsBackground();
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
    function collectActiveWtIds(): Set<string> {
      const ids = new Set<string>();
      for (const [, session] of registry.entries()) {
        if (session.wtId) ids.add(session.wtId);
      }
      return ids;
    }

    const startupActiveWtIds = collectActiveWtIds();
    for (const [label, repoPath] of repoEntries) {
      try {
        cleanupStaleWorktrees(repoPath, inboxDir, startupActiveWtIds);
      } catch (err: unknown) {
        log.warn(`stale worktree cleanup failed for ${label}`, {
          error: err instanceof Error ? err.message : 'unknown',
        });
      }
    }

    const UPDATE_CHECK_INTERVAL_MS = 2 * 60 * 1000;
    setInterval(runUpdateCheck, UPDATE_CHECK_INTERVAL_MS);

    // --- Worktree observability ---

    // Log worktree inventory at startup
    for (const [label, repoPath] of repoEntries) {
      const count = countWorktrees(repoPath);
      if (count > 0) {
        log.info('worktree inventory', { repo: label, count });
      }
    }

    setInterval(() => {
      const stats = getWorktreeGuardStats();
      if (stats.denied > 0 || stats.allowed > 0) {
        log.info('worktree guard stats', stats);
      }
      resetWorktreeGuardStats();
    }, GUARD_STATS_INTERVAL_MS);

    setInterval(() => {
      const activeWtIds = collectActiveWtIds();
      for (const [label, repoPath] of repoEntries) {
        try {
          cleanupStaleWorktrees(repoPath, inboxDir, activeWtIds);
        } catch (err: unknown) {
          log.warn(`periodic worktree cleanup failed for ${label}`, {
            error: err instanceof Error ? err.message : 'unknown',
          });
        }
      }
    }, WORKTREE_CLEANUP_INTERVAL_MS);
  });
});
