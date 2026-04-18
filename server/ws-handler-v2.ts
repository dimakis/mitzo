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
type SendMsg = z.infer<typeof V2SendMessage>;
type StopMsg = z.infer<typeof V2StopMessage>;
type InterruptMsg = z.infer<typeof V2InterruptMessage>;
type PermissionMsg = z.infer<typeof V2PermissionResponseMessage>;
type SetModeMsg = z.infer<typeof V2SetModeMessage>;
import { tracer } from './tracing.js';
import { SpanStatusCode } from '@opentelemetry/api';
import { resolvePending } from './permissions.js';
import { startChat, sendToChat, interruptChat, stopChat, isActive, BASE_REPO } from './chat.js';
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
  const span = tracer.startSpan('ws.reconnect');
  span.setAttribute('ws.connectionId', connectionId);
  span.setAttribute('ws.sessionCount', msg.sessions.length);

  const summaries: Array<{ sessionId: string; replayed: number; running: boolean }> = [];

  try {
    for (const entry of msg.sessions) {
      ctx.connRegistry.watch(connectionId, entry.sessionId);

      const events = ctx.eventStore.getEventsAfter(entry.sessionId, entry.lastSeq);
      for (const evt of events) {
        ctx.connRegistry.get(connectionId)?.transport.send({
          ...evt.payload,
          seq: evt.seq,
        } as Record<string, unknown>);
      }

      // Check if session has an active driver in the SessionRegistry
      const found = ctx.sessionRegistry.findBySessionId(entry.sessionId);
      const running = found ? ctx.sessionRegistry.isActive(found.clientId) : false;

      summaries.push({
        sessionId: entry.sessionId,
        replayed: events.length,
        running,
      });

      log.info('reconnect replay', {
        connectionId,
        sessionId: entry.sessionId,
        lastSeq: entry.lastSeq,
        replayed: events.length,
      });
    }

    ctx.connRegistry.get(connectionId)?.transport.send({
      type: 'reconnected',
      sessions: summaries,
    });

    span.setStatus({ code: SpanStatusCode.OK });
  } catch (err: unknown) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: err instanceof Error ? err.message : 'unknown',
    });
    span.recordException(err instanceof Error ? err : new Error(String(err)));
    throw err;
  } finally {
    span.end();
  }
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

export function handleSwitchSession(
  connectionId: string,
  msg: SwitchSessionMsg,
  ctx: V2HandlerContext,
): void {
  const span = tracer.startSpan('ws.switch_session');
  span.setAttribute('ws.connectionId', connectionId);
  span.setAttribute('ws.sessionId', msg.sessionId ?? 'null');

  try {
    // null sessionId = clear active session
    if (msg.sessionId === null) {
      ctx.connRegistry.setActive(connectionId, null);
      ctx.connRegistry.get(connectionId)?.transport.send({ type: 'session_cleared' });
      span.setStatus({ code: SpanStatusCode.OK });
      return;
    }

    const sessionMeta = ctx.eventStore.getSession(msg.sessionId);
    if (!sessionMeta) {
      ctx.connRegistry.get(connectionId)?.transport.send({
        type: 'error',
        error: `Session not found: ${msg.sessionId}`,
      });
      return;
    }

    ctx.connRegistry.setActive(connectionId, msg.sessionId);

    // Synchronous metadata delivery — design doc §2.2 "no zero-flash"
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

    span.setStatus({ code: SpanStatusCode.OK });
    log.info('switch_session', { connectionId, sessionId: msg.sessionId });
  } catch (err: unknown) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: err instanceof Error ? err.message : 'unknown',
    });
    span.recordException(err instanceof Error ? err : new Error(String(err)));
    throw err;
  } finally {
    span.end();
  }
}

export function handleSendV2(
  connectionId: string,
  transport: SessionTransport,
  msg: SendMsg,
  ctx: V2HandlerContext,
): void {
  const span = tracer.startSpan('ws.send');
  span.setAttribute('ws.connectionId', connectionId);
  span.setAttribute('ws.sessionId', msg.sessionId ?? 'new');

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
      span.setStatus({ code: SpanStatusCode.OK });
      return;
    }

    if (resolution.type === 'error') {
      transport.send({ type: 'error', error: resolution.message });
      span.setStatus({ code: SpanStatusCode.OK });
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

    // Helper: apply skill policy to the correct session clientId.
    // Must be called AFTER startChat registers the session.
    const applySkillPolicy = (targetClientId: string) => {
      if (skillAllowedTools) {
        setSkillPolicy(ctx.sessionRegistry, targetClientId, skillAllowedTools);
      } else {
        clearSkillPolicy(ctx.sessionRegistry, targetClientId);
      }
    };

    const sessionId = msg.sessionId;

    if (sessionId) {
      // Resume existing session
      const found = ctx.sessionRegistry.findBySessionId(sessionId);
      if (found && isActive(found.clientId)) {
        applySkillPolicy(found.clientId);
        sendToChat(found.clientId, prompt, msg.images, msg.contextBlocks, msg.clientMsgId);
        ctx.connRegistry.watch(connectionId, sessionId);
        ctx.connRegistry.setActive(connectionId, sessionId);
        span.setAttribute('routing.decision', 'active');
        span.setStatus({ code: SpanStatusCode.OK });
        return;
      }

      // Session exists in store but no active driver — start with resume
      ctx.connRegistry.watch(connectionId, sessionId);
      ctx.connRegistry.setActive(connectionId, sessionId);
      span.setAttribute('routing.decision', 'resume');
      startChat(transport, connectionId, prompt, {
        resume: sessionId,
        cwd: msg.cwd,
        model: msg.model,
        extraTools: msg.extraTools,
        mode: msg.mode,
        images: msg.images,
        contextBlocks: msg.contextBlocks,
        clientMsgId: msg.clientMsgId,
      });
      // startChat registers under connectionId — safe to apply now
      applySkillPolicy(connectionId);
    } else {
      // null sessionId — new session. Supply onSessionResolved so the
      // connection auto-watches once the SDK resolves the session ID.
      span.setAttribute('routing.decision', 'create');
      const onSessionResolved = (resolvedId: string) => {
        ctx.connRegistry.watch(connectionId, resolvedId);
        ctx.connRegistry.setActive(connectionId, resolvedId);
      };
      startChat(transport, connectionId, prompt, {
        cwd: msg.cwd,
        model: msg.model,
        extraTools: msg.extraTools,
        mode: msg.mode,
        images: msg.images,
        contextBlocks: msg.contextBlocks,
        clientMsgId: msg.clientMsgId,
        onSessionResolved,
      });
      // startChat registers under connectionId — safe to apply now
      applySkillPolicy(connectionId);
    }

    span.setStatus({ code: SpanStatusCode.OK });
  } catch (err: unknown) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: err instanceof Error ? err.message : 'unknown',
    });
    span.recordException(err instanceof Error ? err : new Error(String(err)));
    transport.send({
      type: 'error',
      error: err instanceof Error ? err.message : 'Send failed',
    });
  } finally {
    span.end();
  }
}

export function handleStopV2(connectionId: string, msg: StopMsg, ctx: V2HandlerContext): void {
  const found = ctx.sessionRegistry.findBySessionId(msg.sessionId);
  if (found) {
    stopChat(found.clientId);
    log.info('stop', { connectionId, sessionId: msg.sessionId });
  }
}

export function handleInterruptV2(
  connectionId: string,
  transport: SessionTransport,
  msg: InterruptMsg,
  ctx: V2HandlerContext,
): void {
  const found = ctx.sessionRegistry.findBySessionId(msg.sessionId);
  if (found) {
    ctx.connRegistry.watch(connectionId, msg.sessionId);
    ctx.connRegistry.setActive(connectionId, msg.sessionId);
    interruptChat(found.clientId, msg.prompt, msg.images, msg.contextBlocks, msg.clientMsgId);
    log.info('interrupt', { connectionId, sessionId: msg.sessionId });
  }
}

export function handlePermissionResponseV2(
  connectionId: string,
  msg: PermissionMsg,
  _ctx: V2HandlerContext,
): void {
  resolvePending(msg.permId, msg.decision ?? 'deny');
  log.info('permission_response', {
    connectionId,
    sessionId: msg.sessionId,
    permId: msg.permId,
  });
}

export function handleSetModeV2(
  connectionId: string,
  msg: SetModeMsg,
  ctx: V2HandlerContext,
): void {
  const found = ctx.sessionRegistry.findBySessionId(msg.sessionId);
  if (!found) {
    log.warn('set_mode: session not found', { connectionId, sessionId: msg.sessionId });
    return;
  }

  ctx.sessionRegistry.setMode(found.clientId, msg.mode);

  // Broadcast to all watchers of this session
  ctx.connRegistry.broadcast(msg.sessionId, {
    type: 'mode_changed',
    sessionId: msg.sessionId,
    mode: msg.mode,
  });

  log.info('set_mode', { connectionId, sessionId: msg.sessionId, mode: msg.mode });
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

/**
 * Main v2 message dispatcher. Called for every WS message after hello handshake.
 * Hello is NOT dispatched here — it's handled at the routing layer.
 */
export function dispatchV2Message(
  connectionId: string,
  transport: SessionTransport,
  raw: string,
  ctx: V2HandlerContext,
): void {
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
      handleSwitchSession(connectionId, msg, ctx);
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
