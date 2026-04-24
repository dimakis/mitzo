/**
 * v2 WebSocket message handlers — Phase 1c of single-WS migration.
 *
 * Each handler is a pure function taking (connectionId, message, context).
 * The context bundles the ConnectionRegistry, SessionRegistry, and EventStore
 * so handlers are testable without server-level singletons.
 *
 * Design doc: docs/design/session-isolation-audit.md (PR #220)
 */

import type { SessionTransport, ConnectionRegistry } from '@mitzo/harness';
import type { SessionRegistry } from './session-registry.js';
import type { EventStore } from './event-store.js';
import {
  IncomingWsMessageV2,
  WatchMessage,
  UnwatchMessage,
  SwitchSessionMessage,
  SessionSuspendMessage,
  V2SendMessage,
  V2StopMessage,
  V2InterruptMessage,
  V2PermissionResponseMessage,
  V2SetModeMessage,
} from '@mitzo/protocol';
import type { z } from 'zod';

type WatchMsg = z.infer<typeof WatchMessage>;
type UnwatchMsg = z.infer<typeof UnwatchMessage>;
type SwitchSessionMsg = z.infer<typeof SwitchSessionMessage>;
type SessionSuspendMsg = z.infer<typeof SessionSuspendMessage>;
type SendMsg = z.infer<typeof V2SendMessage>;
type StopMsg = z.infer<typeof V2StopMessage>;
type InterruptMsg = z.infer<typeof V2InterruptMessage>;
type PermissionMsg = z.infer<typeof V2PermissionResponseMessage>;
type SetModeMsg = z.infer<typeof V2SetModeMessage>;
import { randomUUID } from 'crypto';
import { withSpan, withSpanAsync } from './tracing.js';
import { SpanStatusCode } from '@opentelemetry/api';
import { resolvePending, denyPendingBySession } from './permissions.js';
import {
  startChat,
  sendToChat,
  interruptChat,
  stopChat,
  isActive,
  reattachChat,
  rekeyChat,
  BASE_REPO,
  discoverSession,
} from './chat.js';
import { setSkillPolicy, clearSkillPolicy } from './skill-policy.js';
import { resolveSlashCommand } from './slash-commands.js';
import { buildSkillRegistry, isAllowedPath, NATIVE_COMMAND_NAMES } from './app.js';
import type { NativeCommandRegistry } from './native-commands.js';
import { createLogger } from './logger.js';

const log = createLogger('ws-v2');

export interface V2HandlerContext {
  connRegistry: ConnectionRegistry;
  sessionRegistry: SessionRegistry;
  eventStore: EventStore;
  nativeCommands: NativeCommandRegistry;
}

// ─── Hello handshake detection ───────────────────────────────────────────────

/**
 * Detect whether a parsed JSON message is a v2 hello handshake.
 * Used in the upgrade handler to route v2 clients away from the v1 path.
 */
export function isHelloHandshake(msg: unknown): boolean {
  if (!msg || typeof msg !== 'object') return false;
  const obj = msg as Record<string, unknown>;
  return (
    obj.type === 'hello' && typeof obj.protocolVersion === 'number' && obj.protocolVersion >= 2
  );
}

/**
 * Extract the owning connectionId from a composite clientId.
 *
 * ClientId format: `${connectionId}:${suffix}` where suffix is either a
 * sessionId or `new-${uuid}`. ConnectionIds use the format
 * `conn-${timestamp}-${random}` (see server/index.ts L196) and never
 * contain colons, so the first colon is always the separator.
 */
export function getOwnerConnection(clientId: string): string {
  const colonIdx = clientId.indexOf(':');
  return colonIdx === -1 ? clientId : clientId.slice(0, colonIdx);
}

// ─── Handlers ────────────────────────────────────────────────────────────────

export function handleHello(
  connectionId: string,
  transport: SessionTransport,
  ctx: V2HandlerContext,
): string {
  ctx.connRegistry.register(connectionId, transport);

  const conn = ctx.connRegistry.get(connectionId);
  if (conn) {
    conn.transport.send({
      type: 'welcome',
      protocolVersion: 2,
      connectionId,
    });
  }

  log.info('v2 hello', { connectionId });
  return connectionId;
}

export function handleReconnect(
  connectionId: string,
  msg: { type: 'reconnect'; sessions: Array<{ sessionId: string; lastSeq: number }> },
  ctx: V2HandlerContext,
): void {
  withSpan(
    'ws.reconnect',
    { 'ws.connectionId': connectionId, 'ws.sessionCount': msg.sessions.length },
    () => {
      const summaries: Array<{ sessionId: string; replayed: number; running: boolean }> = [];

      for (const entry of msg.sessions) {
        ctx.connRegistry.watch(connectionId, entry.sessionId);

        const events = ctx.eventStore.getEventsAfter(entry.sessionId, entry.lastSeq);
        for (const evt of events) {
          ctx.connRegistry.get(connectionId)?.transport.send({
            ...evt.payload,
            seq: evt.seq,
          } as Record<string, unknown>);
        }

        // Cross-reference with the durable EventStore: markSessionInactive() is
        // called in the query loop's finally block, so isActive=false in the
        // store is ground truth that the loop has ended.
        const found = ctx.sessionRegistry.findBySessionId(entry.sessionId);
        let running = found ? ctx.sessionRegistry.isActive(found.clientId) : false;
        if (running) {
          const storeMeta = ctx.eventStore.getSession(entry.sessionId);
          if (storeMeta && !storeMeta.isActive) {
            running = false;
            log.info('removing stale session from registry', {
              connectionId,
              sessionId: entry.sessionId,
              clientId: found!.clientId,
            });
            ctx.sessionRegistry.remove(found!.clientId);
          }
        }
        if (found && running && !ctx.sessionRegistry.isAttached(found.clientId)) {
          const ownerConnection = getOwnerConnection(found.clientId);
          const ownerGone = !ctx.connRegistry.get(ownerConnection);
          const isOwner = ownerConnection === connectionId;
          if (isOwner || ownerGone) {
            const conn = ctx.connRegistry.get(connectionId);
            if (conn) {
              reattachChat(found.clientId, conn.transport);
              const newClientId = `${connectionId}:${entry.sessionId}`;
              if (found.clientId !== newClientId) {
                rekeyChat(found.clientId, newClientId);
                log.info('rekeyed session to new connection', {
                  connectionId,
                  sessionId: entry.sessionId,
                  oldClientId: found.clientId,
                  newClientId,
                });
              }
              log.info('reattached detached session on reconnect', {
                connectionId,
                sessionId: entry.sessionId,
                clientId: newClientId,
                ownerGone,
              });
            }
          }
        }

        // If the session was suspended, clear suspend state. Don't replay
        // buffered events — they were already replayed from EventStore above
        // (sendOrBuffer appends to both stores, so EventStore covers the
        // suspend period). resume() just clears the suspend flag + buffer.
        let suspendReplayed = 0;
        if (found && running && ctx.sessionRegistry.isSuspended(found.clientId)) {
          const buffered = ctx.sessionRegistry.resume(found.clientId);
          suspendReplayed = buffered.length;

          ctx.connRegistry.get(connectionId)?.transport.send({
            type: 'session_resumed',
            sessionId: entry.sessionId,
            replayed: events.length + suspendReplayed,
          });

          log.info('resumed suspended session', {
            connectionId,
            sessionId: entry.sessionId,
            eventsFromStore: events.length,
            bufferedDuringSuspend: suspendReplayed,
          });
        }

        summaries.push({
          sessionId: entry.sessionId,
          replayed: events.length + suspendReplayed,
          running,
        });

        log.info('reconnect replay', {
          connectionId,
          sessionId: entry.sessionId,
          lastSeq: entry.lastSeq,
          replayed: events.length,
          suspendReplayed,
        });
      }

      ctx.connRegistry.get(connectionId)?.transport.send({
        type: 'reconnected',
        sessions: summaries,
      });
    },
  );
}

export function handleWatch(connectionId: string, msg: WatchMsg, ctx: V2HandlerContext): void {
  ctx.connRegistry.watch(connectionId, msg.sessionId);
  ctx.connRegistry.get(connectionId)?.transport.send({
    type: 'watched',
    sessionId: msg.sessionId,
  });
  log.info('watch', { connectionId, sessionId: msg.sessionId });
}

export function handleUnwatch(connectionId: string, msg: UnwatchMsg, ctx: V2HandlerContext): void {
  ctx.connRegistry.unwatch(connectionId, msg.sessionId);
  ctx.connRegistry.get(connectionId)?.transport.send({
    type: 'unwatched',
    sessionId: msg.sessionId,
  });
  log.info('unwatch', { connectionId, sessionId: msg.sessionId });
}

export async function handleSwitchSession(
  connectionId: string,
  msg: SwitchSessionMsg,
  ctx: V2HandlerContext,
): Promise<void> {
  return withSpanAsync(
    'ws.switch_session',
    { 'ws.connectionId': connectionId, 'ws.sessionId': msg.sessionId ?? 'null' },
    async (span) => {
      if (msg.sessionId === null) {
        const prev = ctx.connRegistry.get(connectionId)?.activeSession;
        if (prev) {
          ctx.connRegistry.unwatch(connectionId, prev);
        }
        ctx.connRegistry.setActive(connectionId, null);
        ctx.connRegistry.get(connectionId)?.transport.send({ type: 'session_cleared' });
        return;
      }

      let sessionMeta = ctx.eventStore.getSession(msg.sessionId);

      if (!sessionMeta) {
        span.setAttribute('ws.discovery', 'sdk_fallback');
        sessionMeta = await discoverSession(msg.sessionId);
      }

      if (!sessionMeta) {
        ctx.connRegistry.get(connectionId)?.transport.send({
          type: 'error',
          error: `Session not found: ${msg.sessionId}`,
        });
        return;
      }

      const prev = ctx.connRegistry.get(connectionId)?.activeSession;
      if (prev && prev !== msg.sessionId) {
        ctx.connRegistry.unwatch(connectionId, prev);
      }
      ctx.connRegistry.setActive(connectionId, msg.sessionId);

      ctx.connRegistry.get(connectionId)?.transport.send({
        type: 'session_switched',
        sessionId: msg.sessionId,
        mode: sessionMeta.mode,
        cwd: sessionMeta.cwd,
        branch: sessionMeta.branch,
        wtId: sessionMeta.wtId,
        tokens: {
          input: sessionMeta.inputTokens,
          output: sessionMeta.outputTokens,
          cacheRead: sessionMeta.cacheReadTokens,
          cacheCreation: sessionMeta.cacheCreationTokens,
          costUsd: sessionMeta.totalCostUsd,
        },
      });

      log.info('switch_session', { connectionId, sessionId: msg.sessionId });
    },
  );
}

export function handleSendV2(
  connectionId: string,
  transport: SessionTransport,
  msg: SendMsg,
  ctx: V2HandlerContext,
): void {
  withSpan(
    'ws.send',
    { 'ws.connectionId': connectionId, 'ws.sessionId': msg.sessionId ?? 'new' },
    (span) => {
      try {
        const rawCwd = msg.cwd || BASE_REPO;
        const cwd = rawCwd && isAllowedPath(rawCwd) ? rawCwd : BASE_REPO;
        const skillRegistry = buildSkillRegistry(cwd);
        const resolution = resolveSlashCommand(msg.prompt, skillRegistry, NATIVE_COMMAND_NAMES);

        if (resolution.type === 'native') {
          const result = ctx.nativeCommands.execute(
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
          return;
        }

        if (resolution.type === 'error') {
          transport.send({ type: 'error', error: resolution.message });
          return;
        }

        const prompt = resolution.type === 'skill' ? resolution.renderedPrompt : msg.prompt;
        const skillAllowedTools = resolution.type === 'skill' ? resolution.allowedTools : undefined;

        if (resolution.type === 'skill') {
          transport.send({
            type: 'skill_invoked',
            v: 2,
            name: resolution.name,
            source: skillRegistry.get(resolution.name)?.scope || 'bundled',
            arguments: resolution.arguments,
            ...(resolution.collisions ? { collisions: resolution.collisions } : {}),
          });
        }

        const applySkillPolicy = (targetClientId: string) => {
          if (skillAllowedTools) {
            setSkillPolicy(ctx.sessionRegistry, targetClientId, skillAllowedTools);
          } else {
            clearSkillPolicy(ctx.sessionRegistry, targetClientId);
          }
        };

        const sessionId = msg.sessionId;

        if (sessionId) {
          const found = ctx.sessionRegistry.findBySessionId(sessionId);
          if (found && isActive(found.clientId)) {
            const storeMeta = ctx.eventStore.getSession(sessionId);
            const staleInMemory = storeMeta && !storeMeta.isActive;

            if (staleInMemory) {
              log.info('removing stale session from registry (send)', {
                connectionId,
                sessionId,
                clientId: found.clientId,
              });
              ctx.sessionRegistry.remove(found.clientId);
            } else {
              const ownerConnection = getOwnerConnection(found.clientId);
              const isOwner = ownerConnection === connectionId;
              const isDetached = !ctx.sessionRegistry.isAttached(found.clientId);

              let activeClientId = found.clientId;
              if (!isOwner) {
                const oldTransport = found.session?.transport;
                if (oldTransport?.isOpen()) {
                  oldTransport.send({ type: 'session_takeover', sessionId });
                }
                ctx.connRegistry.unwatch(ownerConnection, sessionId);
                denyPendingBySession(sessionId);

                reattachChat(found.clientId, transport);
                const newClientId = `${connectionId}:${sessionId}`;
                if (found.clientId !== newClientId) {
                  rekeyChat(found.clientId, newClientId);
                  activeClientId = newClientId;
                }
                log.info('takeover on send', {
                  connectionId,
                  sessionId,
                  oldOwner: ownerConnection,
                  newClientId: activeClientId,
                });
              } else if (isDetached) {
                reattachChat(found.clientId, transport);
                log.info('reattached own detached session on send', {
                  connectionId,
                  sessionId,
                });
              }
              applySkillPolicy(activeClientId);
              sendToChat(activeClientId, prompt, msg.images, msg.contextBlocks, msg.clientMsgId);
              ctx.connRegistry.watch(connectionId, sessionId);
              ctx.connRegistry.setActive(connectionId, sessionId);
              span.setAttribute('routing.decision', isOwner ? 'active' : 'takeover');
              return;
            }
          }

          const sessionClientId = `${connectionId}:${sessionId}`;
          ctx.connRegistry.watch(connectionId, sessionId);
          ctx.connRegistry.setActive(connectionId, sessionId);
          span.setAttribute('routing.decision', 'resume');
          startChat(transport, sessionClientId, prompt, {
            resume: sessionId,
            cwd: msg.cwd,
            model: msg.model,
            extraTools: msg.extraTools,
            isolation: msg.isolation,
            mode: msg.mode,
            images: msg.images,
            contextBlocks: msg.contextBlocks,
            clientMsgId: msg.clientMsgId,
          });
          applySkillPolicy(sessionClientId);
        } else {
          const sessionClientId = `${connectionId}:new-${randomUUID().slice(0, 8)}`;
          span.setAttribute('routing.decision', 'create');
          const onSessionResolved = (resolvedId: string) => {
            ctx.connRegistry.watch(connectionId, resolvedId);
            ctx.connRegistry.setActive(connectionId, resolvedId);
          };
          startChat(transport, sessionClientId, prompt, {
            cwd: msg.cwd,
            model: msg.model,
            extraTools: msg.extraTools,
            isolation: msg.isolation,
            mode: msg.mode,
            images: msg.images,
            contextBlocks: msg.contextBlocks,
            clientMsgId: msg.clientMsgId,
            onSessionResolved,
          });
          applySkillPolicy(sessionClientId);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        span.recordException(err instanceof Error ? err : new Error(message));
        span.setStatus({ code: SpanStatusCode.ERROR, message });
        transport.send({
          type: 'error',
          error: err instanceof Error ? err.message : 'Send failed',
        });
      }
    },
  );
}

export function handleStopV2(connectionId: string, msg: StopMsg, ctx: V2HandlerContext): void {
  withSpan('ws.stop', { 'ws.connectionId': connectionId, 'ws.sessionId': msg.sessionId }, () => {
    const found = ctx.sessionRegistry.findBySessionId(msg.sessionId);
    if (found) {
      stopChat(found.clientId);
      log.info('stop', { connectionId, sessionId: msg.sessionId });
    }
  });
}

export function handleInterruptV2(
  connectionId: string,
  transport: SessionTransport,
  msg: InterruptMsg,
  ctx: V2HandlerContext,
): void {
  withSpan(
    'ws.interrupt',
    { 'ws.connectionId': connectionId, 'ws.sessionId': msg.sessionId },
    () => {
      const found = ctx.sessionRegistry.findBySessionId(msg.sessionId);
      if (!found) return;

      let activeClientId = found.clientId;

      if (isActive(found.clientId)) {
        const storeMeta = ctx.eventStore.getSession(msg.sessionId);
        const staleInMemory = storeMeta && !storeMeta.isActive;

        if (staleInMemory) {
          log.info('removing stale session from registry (interrupt)', {
            connectionId,
            sessionId: msg.sessionId,
            clientId: found.clientId,
          });
          ctx.sessionRegistry.remove(found.clientId);
        } else {
          const ownerConnection = getOwnerConnection(found.clientId);
          const isOwner = ownerConnection === connectionId;
          const isDetached = !ctx.sessionRegistry.isAttached(found.clientId);

          if (!isOwner) {
            const oldTransport = found.session?.transport;
            if (oldTransport?.isOpen()) {
              oldTransport.send({ type: 'session_takeover', sessionId: msg.sessionId });
            }
            ctx.connRegistry.unwatch(ownerConnection, msg.sessionId);
            denyPendingBySession(msg.sessionId);

            reattachChat(found.clientId, transport);
            const newClientId = `${connectionId}:${msg.sessionId}`;
            if (found.clientId !== newClientId) {
              rekeyChat(found.clientId, newClientId);
              activeClientId = newClientId;
            }
            log.info('takeover on interrupt', {
              connectionId,
              sessionId: msg.sessionId,
              oldOwner: ownerConnection,
              newClientId: activeClientId,
            });
          } else if (isDetached) {
            reattachChat(found.clientId, transport);
          }

          ctx.connRegistry.watch(connectionId, msg.sessionId);
          ctx.connRegistry.setActive(connectionId, msg.sessionId);
          interruptChat(activeClientId, msg.prompt, msg.images, msg.contextBlocks, msg.clientMsgId);
          log.info('interrupt', { connectionId, sessionId: msg.sessionId });
          return;
        }
      }

      const sessionClientId = `${connectionId}:${msg.sessionId}`;
      ctx.connRegistry.watch(connectionId, msg.sessionId);
      ctx.connRegistry.setActive(connectionId, msg.sessionId);
      startChat(transport, sessionClientId, msg.prompt, {
        resume: msg.sessionId,
        images: msg.images,
        contextBlocks: msg.contextBlocks,
        clientMsgId: msg.clientMsgId,
      });
      log.info('interrupt_resume', { connectionId, sessionId: msg.sessionId });
    },
  );
}

export function handlePermissionResponseV2(
  connectionId: string,
  msg: PermissionMsg,
  _ctx: V2HandlerContext,
): void {
  withSpan(
    'ws.permission_response',
    {
      'ws.connectionId': connectionId,
      'ws.sessionId': msg.sessionId ?? '',
      'ws.permId': msg.permId,
    },
    () => {
      resolvePending(msg.permId, msg.decision ?? 'deny');
      log.info('permission_response', {
        connectionId,
        sessionId: msg.sessionId,
        permId: msg.permId,
      });
    },
  );
}

export function handleSetModeV2(
  connectionId: string,
  msg: SetModeMsg,
  ctx: V2HandlerContext,
): void {
  withSpan(
    'ws.set_mode',
    { 'ws.connectionId': connectionId, 'ws.sessionId': msg.sessionId, 'ws.mode': msg.mode },
    () => {
      const found = ctx.sessionRegistry.findBySessionId(msg.sessionId);
      if (!found) {
        log.warn('set_mode: session not found', { connectionId, sessionId: msg.sessionId });
        return;
      }

      ctx.sessionRegistry.setMode(found.clientId, msg.mode);

      ctx.connRegistry.broadcast(msg.sessionId, {
        type: 'mode_changed',
        sessionId: msg.sessionId,
        mode: msg.mode,
      });

      log.info('set_mode', { connectionId, sessionId: msg.sessionId, mode: msg.mode });
    },
  );
}

export function handleSessionSuspend(
  connectionId: string,
  msg: SessionSuspendMsg,
  ctx: V2HandlerContext,
): void {
  withSpan(
    'ws.session_suspend',
    { 'ws.connectionId': connectionId, 'ws.sessionCount': msg.sessions.length },
    () => {
      for (const entry of msg.sessions) {
        const found = ctx.sessionRegistry.findBySessionId(entry.sessionId);
        if (!found) {
          log.warn('suspend: session not found', { connectionId, sessionId: entry.sessionId });
          continue;
        }

        const ownerConnection = getOwnerConnection(found.clientId);
        if (ownerConnection !== connectionId) {
          log.warn('suspend: not owner', {
            connectionId,
            sessionId: entry.sessionId,
            owner: ownerConnection,
          });
          continue;
        }

        ctx.sessionRegistry.suspend(found.clientId, entry.lastSeq);
        log.info('session suspended', {
          connectionId,
          sessionId: entry.sessionId,
          clientId: found.clientId,
          lastSeq: entry.lastSeq,
        });
      }
    },
  );
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

/**
 * Main v2 message dispatcher. Called for every WS message after hello handshake.
 * Hello is NOT dispatched here — it's handled at the routing layer.
 */
export async function dispatchV2Message(
  connectionId: string,
  transport: SessionTransport,
  raw: string,
  ctx: V2HandlerContext,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.debug('malformed JSON', { connectionId });
    return;
  }

  const result = IncomingWsMessageV2.safeParse(parsed);
  if (!result.success) {
    log.debug('unrecognized v2 message', {
      connectionId,
      type: (parsed as Record<string, unknown>)?.type,
    });
    return;
  }

  const msg = result.data;

  switch (msg.type) {
    case 'hello':
      // Already handled at routing layer, ignore duplicate
      break;
    case 'reconnect':
      handleReconnect(connectionId, msg, ctx);
      break;
    case 'watch':
      handleWatch(connectionId, msg, ctx);
      break;
    case 'unwatch':
      handleUnwatch(connectionId, msg, ctx);
      break;
    case 'switch_session':
      await handleSwitchSession(connectionId, msg, ctx);
      break;
    case 'session_suspend':
      handleSessionSuspend(connectionId, msg, ctx);
      break;
    case 'send':
      handleSendV2(connectionId, transport, msg, ctx);
      break;
    case 'stop':
      handleStopV2(connectionId, msg, ctx);
      break;
    case 'interrupt':
      handleInterruptV2(connectionId, transport, msg, ctx);
      break;
    case 'permission_response':
      handlePermissionResponseV2(connectionId, msg, ctx);
      break;
    case 'set_mode':
      handleSetModeV2(connectionId, msg, ctx);
      break;
  }
}
