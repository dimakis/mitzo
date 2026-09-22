import { permissionRevision, recordPermissionChange } from './session-permission-revision.js';
import {
  resolveAccountSelection,
  resolveEffectiveAccountSelection,
  loadAccountProfiles,
} from './account-profiles.js';
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
import { effectivePermissionMode } from '@mitzo/harness';
import { ExecutionAdmissionError } from '@mitzo/protocol/event-store';
import type { SessionRegistry } from './session-registry.js';
import type { EventStore } from './event-store.js';
import { toClientState } from './event-store.js';
import {
  IncomingWsMessageV2,
  WatchMessage,
  UnwatchMessage,
  SwitchSessionMessage,
  SessionSuspendMessage,
  SessionCloseMessage,
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
type SessionCloseMsg = z.infer<typeof SessionCloseMessage>;
type SendMsg = z.infer<typeof V2SendMessage>;
type StopMsg = z.infer<typeof V2StopMessage>;
type InterruptMsg = z.infer<typeof V2InterruptMessage>;
type PermissionMsg = z.infer<typeof V2PermissionResponseMessage>;
type SetModeMsg = z.infer<typeof V2SetModeMessage>;
import { randomUUID } from 'crypto';
import { withSpan, withSpanAsync } from './tracing.js';
import { SpanStatusCode } from '@opentelemetry/api';
import {
  resolvePending,
  denyPendingBySession,
  getPendingRequestsBySession,
} from './permissions.js';
import {
  startChat,
  sendToChat,
  interruptChat,
  preflightChatCommand,
  preflightStartupProviderCommand,
  nativeStartupSessionId,
  stopChat,
  closeSessionByUser,
  isActive,
  reattachChat,
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

function assertActiveAccountIdentity(
  ctx: V2HandlerContext,
  sessionId: string,
  accountId: string,
): void {
  const boundAccountId = ctx.eventStore.getSession(sessionId)?.accountBinding?.accountId;
  if (boundAccountId !== accountId)
    throw new Error(
      'This task is bound to its original account. Start a new task to change accounts.',
    );
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

// ─── State mismatch detection (Phase 2) ─────────────────────────────────────

export interface StateMismatchResult {
  mismatch: boolean;
  details?: string;
}

/**
 * Detect inconsistencies between in-memory SessionRegistry and durable
 * EventStore session state. Runs on every send/interrupt to surface bugs
 * before Phase 3 replaces routing logic.
 */
export function detectStateMismatch(
  sessionId: string,
  registry: SessionRegistry,
  store: EventStore,
): StateMismatchResult {
  const found = registry.findBySessionId(sessionId);
  const state = store.getSessionState(sessionId);

  // CLOSING sessions are in graceful shutdown — registry entry may or may not
  // exist depending on timing, so don't flag mismatches for them.
  if (state === 'CLOSING') return { mismatch: false };

  const registryHas = !!found;
  const shouldHave = state != null && state !== 'ENDED';

  if (registryHas && !shouldHave) {
    return {
      mismatch: true,
      details: `registry has session but state=${state ?? 'null'}`,
    };
  }

  if (!registryHas && shouldHave) {
    return {
      mismatch: true,
      details: `registry missing session but state=${state}`,
    };
  }

  if (found && state) {
    const attached = registry.isAttached(found.clientId);
    const shouldBeAttached = state === 'ACTIVE';
    const shouldBeDetached = state === 'DETACHED' || state === 'SUSPENDED';

    if (attached && shouldBeDetached) {
      return {
        mismatch: true,
        details: `transport attached but state=${state}`,
      };
    }
    if (!attached && shouldBeAttached) {
      return {
        mismatch: true,
        details: `transport detached but state=${state}`,
      };
    }
  }

  return { mismatch: false };
}

// ─── Boot context replay helper ─────────────────────────────────────────────

/**
 * Send cached boot_context to a connection for a given session.
 * Hot path: in-memory ManagedSession cache.
 * Cold path: serialized JSON from EventStore (ended/restarted sessions).
 */
function sendBootContext(connectionId: string, sessionId: string, ctx: V2HandlerContext): void {
  const conn = ctx.connRegistry.get(connectionId);
  if (!conn) return;

  for (const request of getPendingRequestsBySession(sessionId)) {
    try {
      conn.transport.send({ type: 'permission_request', ...request });
    } catch (err) {
      // Leave the request pending for the next reconnect and continue with
      // other replay messages, including the boot context.
      log.warn('permission replay delivery failed', {
        sessionId,
        permId: request.permId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Hot path: running session with in-memory cache
  const found = ctx.sessionRegistry.findBySessionId(sessionId);
  if (found?.session?.bootContext) {
    conn.transport.send({
      type: 'boot_context',
      sessionId,
      ...found.session.bootContext,
    });
    return;
  }

  // Cold path: ended/non-running session — read from EventStore
  const meta = ctx.eventStore.getSession(sessionId);
  if (meta?.bootContext) {
    try {
      const parsed = JSON.parse(meta.bootContext);
      conn.transport.send({
        type: 'boot_context',
        sessionId,
        ...parsed,
      });
    } catch (err) {
      log.warn('invalid boot_context JSON in EventStore', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
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
      const summaries: Array<{ sessionId: string; replayed: number }> = [];

      for (const entry of msg.sessions) {
        ctx.connRegistry.watch(connectionId, entry.sessionId);

        // Set cursor to client's lastSeq BEFORE replay, so periodic sync
        // sees a reasonable cursor during replay instead of 0.
        ctx.connRegistry.resetCursor(connectionId, entry.sessionId, entry.lastSeq);

        // Resolve ownership before replay. A suspended session deliberately
        // remains in memory through the grace period, and its old transport
        // can still look attached while the browser creates a new connection.
        // Replaying to that new connection without taking it over leaves the
        // old transport as the driver until the next user send, which can
        // interleave an old error with the new input.
        const found = ctx.sessionRegistry.findBySessionId(entry.sessionId);
        const storeState = ctx.eventStore.getSessionState(entry.sessionId);
        let running = found ? ctx.sessionRegistry.isActive(found.clientId) : false;
        if (running && (storeState === 'ENDED' || storeState === 'CLOSING')) {
          running = false;
          log.info('removing stale session from registry (state-based)', {
            connectionId,
            sessionId: entry.sessionId,
            clientId: found!.clientId,
            storeState,
          });
          ctx.sessionRegistry.remove(found!.clientId);
        }
        const wasSuspended = !!found && running && ctx.sessionRegistry.isSuspended(found.clientId);
        // SessionRegistry.reattach() clears suspend state and its buffer. Consume
        // that transition before moving the transport so the later replay can
        // report it, while EventStore remains the single delivery source.
        let reconciledSuspendEvents = 0;
        if (wasSuspended) {
          const ownerConnection =
            found!.session?.ownerConnectionId ?? getOwnerConnection(found!.clientId);
          if (ownerConnection !== connectionId) {
            const oldTransport = found!.session?.transport;
            if (oldTransport?.isOpen())
              oldTransport.send({ type: 'session_takeover', sessionId: entry.sessionId });
            ctx.connRegistry.unwatch(ownerConnection, entry.sessionId);
            denyPendingBySession(entry.sessionId);
          }

          // The durable event replay below covers the same events buffered
          // during suspension. Do not send this transient buffer again.
          reconciledSuspendEvents = ctx.sessionRegistry.resume(found!.clientId).length;

          if (ownerConnection !== connectionId) {
            const conn = ctx.connRegistry.get(connectionId);
            if (conn) {
              reattachChat(found!.clientId, conn.transport);
              if (found!.session) found!.session.ownerConnectionId = connectionId;
              log.info('took over suspended session on reconnect', {
                connectionId,
                sessionId: entry.sessionId,
                oldOwner: ownerConnection,
                clientId: found!.clientId,
              });
            }
          }
        }

        const events = ctx.eventStore.getEventsAfter(entry.sessionId, entry.lastSeq);
        for (const evt of events) {
          ctx.connRegistry.get(connectionId)?.transport.send({
            ...evt.payload,
            seq: evt.seq,
          } as Record<string, unknown>);
        }

        // Reset cursor to last replayed seq — prevents duplicate delivery from
        // periodic sync. If no events replayed, cursor stays at client's lastSeq.
        const newCursor = events.length > 0 ? events[events.length - 1].seq : entry.lastSeq;
        ctx.connRegistry.resetCursor(connectionId, entry.sessionId, newCursor);

        if (found && running) {
          const ownerConnection =
            found.session?.ownerConnectionId ?? getOwnerConnection(found.clientId);
          const ownerGone = !ctx.connRegistry.get(ownerConnection);
          const isOwner = ownerConnection === connectionId;
          if ((isOwner && !ctx.sessionRegistry.isAttached(found.clientId)) || ownerGone) {
            const conn = ctx.connRegistry.get(connectionId);
            if (conn) {
              reattachChat(found.clientId, conn.transport);
              if (found.session) found.session.ownerConnectionId = connectionId;
              log.info('reattached detached session on reconnect', {
                connectionId,
                sessionId: entry.sessionId,
                clientId: found.clientId,
                ownerGone,
              });
            }
          }
        }

        if (wasSuspended) {
          ctx.connRegistry.get(connectionId)?.transport.send({
            type: 'session_resumed',
            sessionId: entry.sessionId,
            replayed: events.length,
          });

          log.info('resumed suspended session', {
            connectionId,
            sessionId: entry.sessionId,
            eventsFromStore: events.length,
            reconciledBufferedEvents: reconciledSuspendEvents,
          });
        }

        const mode = found?.session?.mode ?? ctx.eventStore.getSession(entry.sessionId)?.mode;
        if (mode) {
          ctx.connRegistry.get(connectionId)?.transport.send({
            type: 'mode_changed',
            sessionId: entry.sessionId,
            mode,
          });
        }

        summaries.push({
          sessionId: entry.sessionId,
          replayed: events.length,
        });

        // Re-send boot_context so pills reappear after reconnect.
        // Uses shared helper with hot (in-memory) + cold (EventStore) paths.
        sendBootContext(connectionId, entry.sessionId, ctx);

        log.info('reconnect replay', {
          connectionId,
          sessionId: entry.sessionId,
          lastSeq: entry.lastSeq,
          replayed: events.length,
          reconciledSuspendEvents,
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
          sessionId: msg.sessionId,
          error: `Session not found: ${msg.sessionId}`,
        });
        return;
      }

      const prev = ctx.connRegistry.get(connectionId)?.activeSession;
      if (prev && prev !== msg.sessionId) {
        ctx.connRegistry.unwatch(connectionId, prev);
      }
      // Watch the session immediately so events from a running query loop
      // reach this client before the first send. Without this, the client
      // sits in a blind spot between switch_session and the first send —
      // any events emitted by the query loop during that window are lost.
      ctx.connRegistry.watch(connectionId, msg.sessionId);
      ctx.connRegistry.setActive(connectionId, msg.sessionId);

      // Cross-reference registry with durable state to avoid reporting
      ctx.connRegistry.get(connectionId)?.transport.send({
        type: 'session_switched',
        sessionId: msg.sessionId,
        mode: ctx.sessionRegistry.findBySessionId(msg.sessionId)?.session.mode ?? sessionMeta.mode,
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

      // Immediately emit current session state so the client derives running
      // status without waiting for the next live event or periodic sync.
      const currentState = ctx.eventStore.getSessionState(msg.sessionId);
      if (currentState) {
        ctx.connRegistry.get(connectionId)?.transport.send({
          type: 'session_state_changed',
          sessionId: msg.sessionId,
          state: toClientState(currentState),
          internalState: currentState,
          timestamp: Date.now(),
        });
      }

      // Re-send boot_context so pills appear on session switch.
      // Uses shared helper with hot (in-memory) + cold (EventStore) paths.
      sendBootContext(connectionId, msg.sessionId, ctx);

      log.info('switch_session', { connectionId, sessionId: msg.sessionId });
    },
  ).catch((error: unknown) => {
    try {
      ctx.connRegistry.get(connectionId)?.transport.send({
        type: 'error',
        ...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
        error: error instanceof Error ? error.message : 'Session switch failed',
      });
    } catch (deliveryError) {
      log.warn('switch_session error delivery failed', { connectionId, error: deliveryError });
    }
    // REST and dispatch callers must still observe the failed operation.
    throw error;
  });
}

export function handleSendV2(
  connectionId: string,
  transport: SessionTransport,
  msg: SendMsg,
  ctx: V2HandlerContext,
  delivery?: { initialSessionId?: string; awaitStartupAdmission?: boolean },
): Promise<'native' | void> {
  return withSpanAsync<'native' | void>(
    'ws.send',
    { 'ws.connectionId': connectionId, 'ws.sessionId': msg.sessionId ?? 'new' },
    async (span) => {
      try {
        let resolveStartupAdmission: (() => void) | undefined;
        let rejectStartupAdmission: ((error: unknown) => void) | undefined;
        const startupAdmission = delivery?.awaitStartupAdmission
          ? new Promise<void>((resolve, reject) => {
              resolveStartupAdmission = resolve;
              rejectStartupAdmission = reject;
            })
          : undefined;
        let emitSkillInvoked = () => {};
        let skillInvoked = false;
        const onStartupAdmission = (error?: unknown) => {
          if (error) rejectStartupAdmission?.(error);
          else {
            if (!skillInvoked) {
              emitSkillInvoked();
              skillInvoked = true;
            }
            resolveStartupAdmission?.();
          }
        };
        const storedMeta = msg.sessionId ? ctx.eventStore.getSession(msg.sessionId) : undefined;
        const storedBinding = storedMeta?.accountBinding;
        const accountProfiles = msg.accountId || storedBinding ? loadAccountProfiles() : undefined;
        // Validation-only gate before dispatch; startup revalidates against this same snapshot.
        const accountBinding = resolveAccountSelection(
          msg,
          storedBinding,
          !!msg.sessionId,
          accountProfiles,
        );
        const effectiveSelection = resolveEffectiveAccountSelection(
          msg,
          storedMeta,
          accountBinding,
        );
        const rawCwd = msg.cwd || BASE_REPO;
        const cwd = rawCwd && isAllowedPath(rawCwd) ? rawCwd : BASE_REPO;
        const skillRegistry = buildSkillRegistry(cwd);
        const resolution = resolveSlashCommand(msg.prompt, skillRegistry, NATIVE_COMMAND_NAMES);

        if (resolution.type === 'native') {
          void ctx.nativeCommands
            .execute(resolution.name, resolution.arguments, skillRegistry, { transport })
            .then((result) => {
              if (result) {
                transport.send({
                  type: 'native_command_result',
                  v: 2,
                  command: result.command,
                  content: result.content,
                });
              }
            })
            .catch((err: unknown) => {
              transport.send({
                type: 'error',
                error: `Command /${resolution.name} failed: ${err instanceof Error ? err.message : 'unknown'}`,
              });
            });
          return 'native';
        }

        if (resolution.type === 'error') {
          transport.send({ type: 'error', error: resolution.message });
          return;
        }

        const prompt = resolution.type === 'skill' ? resolution.renderedPrompt : msg.prompt;
        // Preflight sees exactly what the user typed, including a meaningful
        // slash-command name, never the rendered skill body.
        const userIntent = msg.prompt;
        const skillAllowedTools = resolution.type === 'skill' ? resolution.allowedTools : undefined;

        emitSkillInvoked = () => {
          if (resolution.type !== 'skill') return;
          transport.send({
            type: 'skill_invoked',
            v: 2,
            name: resolution.name,
            source: skillRegistry.get(resolution.name)?.scope || 'bundled',
            arguments: resolution.arguments,
            ...(resolution.collisions ? { collisions: resolution.collisions } : {}),
          });
        };

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
          const storeState = ctx.eventStore.getSessionState(sessionId);

          const routesToActiveRuntime =
            !!found &&
            isActive(found.clientId) &&
            storeState !== 'ENDED' &&
            storeState !== 'CLOSING' &&
            storeState !== null;
          if (!routesToActiveRuntime) {
            const duplicate = preflightStartupProviderCommand(ctx.eventStore, {
              sessionId,
              clientMsgId: msg.clientMsgId,
              prompt,
              cwd,
              images: msg.images,
              contextBlocks: msg.contextBlocks,
              model: effectiveSelection.model,
              reasoningEffort: effectiveSelection.reasoningEffort,
            });
            if (duplicate) {
              log.info('duplicate cold provider send', { connectionId, sessionId });
              return;
            }
          }

          // Phase 2: detect state mismatches (observability only)
          const mismatch = detectStateMismatch(sessionId, ctx.sessionRegistry, ctx.eventStore);
          if (mismatch.mismatch) {
            log.error('session state mismatch detected (send)', {
              connectionId,
              sessionId,
              storeState,
              registryHas: !!found,
              details: mismatch.details,
            });
            span.setAttribute('session.state_mismatch', mismatch.details ?? 'unknown');
          }

          // State-based routing (Phase 3): durable state is the single source of truth.
          // ACTIVE/DETACHED/SUSPENDED → running path (send to existing query loop)
          // CLOSING/ENDED/null → resume path (zombie cleanup first if needed)
          if (routesToActiveRuntime && found) {
            if (msg.accountId) assertActiveAccountIdentity(ctx, sessionId, msg.accountId);
            const duplicate = preflightChatCommand(
              found.clientId,
              prompt,
              msg.images,
              msg.contextBlocks,
              msg.clientMsgId,
              msg.accountId ? msg.model : undefined,
              msg.accountId ? msg.reasoningEffort : undefined,
            );
            const ownerConnection =
              found.session?.ownerConnectionId ?? getOwnerConnection(found.clientId);
            const isOwner = ownerConnection === connectionId;
            const isDetached = !ctx.sessionRegistry.isAttached(found.clientId);

            const activeClientId = found.clientId;
            if (!isOwner) {
              const oldTransport = found.session?.transport;
              if (oldTransport?.isOpen()) {
                oldTransport.send({ type: 'session_takeover', sessionId });
              }
              ctx.connRegistry.unwatch(ownerConnection, sessionId);
              denyPendingBySession(sessionId);

              reattachChat(found.clientId, transport);
              if (found.session) found.session.ownerConnectionId = connectionId;
              log.info('takeover on send', {
                connectionId,
                sessionId,
                oldOwner: ownerConnection,
                newClientId: activeClientId,
                storeState,
              });
            } else if (isDetached) {
              reattachChat(found.clientId, transport);
              if (found.session) found.session.ownerConnectionId = connectionId;
              log.info('reattached own detached session on send', {
                connectionId,
                sessionId,
                storeState,
              });
            }
            ctx.connRegistry.watch(connectionId, sessionId);
            ctx.connRegistry.setActive(connectionId, sessionId);
            if (duplicate) {
              log.info('duplicate send', { connectionId, sessionId });
              return;
            }
            emitSkillInvoked();
            applySkillPolicy(activeClientId);
            const accepted =
              resolution.type === 'skill'
                ? await sendToChat(
                    activeClientId,
                    prompt,
                    msg.images,
                    msg.contextBlocks,
                    msg.clientMsgId,
                    msg.accountId ? msg.model : undefined,
                    msg.accountId ? msg.reasoningEffort : undefined,
                    undefined,
                    userIntent,
                  )
                : await sendToChat(
                    activeClientId,
                    prompt,
                    msg.images,
                    msg.contextBlocks,
                    msg.clientMsgId,
                    msg.accountId ? msg.model : undefined,
                    msg.accountId ? msg.reasoningEffort : undefined,
                  );
            if (!accepted) throw new Error('Session is not accepting input. Please retry.');
            span.setAttribute('routing.decision', isOwner ? 'active' : 'takeover');
            return;
          }

          // A send payload may still contain the previous chat's mode before
          // switch hydration. Only set_mode changes an existing session's policy.
          const resumePermission = found?.session?.mode
            ? {
                mode: effectivePermissionMode(found.session),
                revision: permissionRevision(ctx.eventStore, sessionId),
              }
            : undefined;

          // Zombie — abort before resume.
          if (found && isActive(found.clientId)) {
            log.info('aborting zombie session before resume', {
              connectionId,
              sessionId,
              clientId: found.clientId,
              storeState,
            });
            stopChat(found.clientId);
          }

          // Resume from history.
          const sessionClientId = `${connectionId}:${sessionId}`;
          ctx.connRegistry.watch(connectionId, sessionId);
          ctx.connRegistry.setActive(connectionId, sessionId);
          span.setAttribute('routing.decision', 'resume');
          startChat(transport, sessionClientId, prompt, {
            resume: sessionId,
            cwd: msg.cwd,
            model: effectiveSelection.model,
            reasoningEffort: effectiveSelection.reasoningEffort,
            accountId: msg.accountId,
            accountProfiles,
            extraTools: msg.extraTools,
            skillAllowedTools,
            isolation: msg.isolation,
            resumePermission,
            images: msg.images,
            contextBlocks: msg.contextBlocks,
            clientMsgId: msg.clientMsgId,
            onStartupAdmission,
            telosTaskId: msg.telosTaskId,
            agentName: msg.agentName,
            userIntent,
          }).catch((err: unknown) =>
            transport.send({
              type: 'error',
              error: err instanceof Error ? err.message : 'Session startup failed',
            }),
          );
          applySkillPolicy(sessionClientId);
        } else {
          const startupSessionId =
            delivery?.initialSessionId ?? nativeStartupSessionId(msg.clientMsgId);
          const duplicate = preflightStartupProviderCommand(ctx.eventStore, {
            sessionId: startupSessionId,
            clientMsgId: msg.clientMsgId,
            prompt,
            cwd,
            images: msg.images,
            contextBlocks: msg.contextBlocks,
            model: effectiveSelection.model,
            reasoningEffort: effectiveSelection.reasoningEffort,
          });
          if (duplicate) {
            log.info('duplicate initial provider send', {
              connectionId,
              sessionId: startupSessionId,
            });
            return;
          }
          const sessionClientId = `${connectionId}:new-${randomUUID().slice(0, 8)}`;
          span.setAttribute('routing.decision', 'create');
          const onSessionResolved = (resolvedId: string) => {
            ctx.connRegistry.watch(connectionId, resolvedId);
            ctx.connRegistry.setActive(connectionId, resolvedId);
          };
          startChat(transport, sessionClientId, prompt, {
            initialSessionId: delivery?.initialSessionId,
            cwd: msg.cwd,
            model: effectiveSelection.model,
            reasoningEffort: effectiveSelection.reasoningEffort,
            accountId: msg.accountId,
            accountProfiles,
            extraTools: msg.extraTools,
            skillAllowedTools,
            isolation: msg.isolation,
            mode: msg.mode,
            images: msg.images,
            contextBlocks: msg.contextBlocks,
            clientMsgId: msg.clientMsgId,
            onSessionResolved,
            onStartupAdmission,
            telosTaskId: msg.telosTaskId,
            agentName: msg.agentName,
            userIntent,
          }).catch((err: unknown) =>
            transport.send({
              type: 'error',
              error: err instanceof Error ? err.message : 'Session startup failed',
            }),
          );
          applySkillPolicy(sessionClientId);
        }
        await startupAdmission;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        span.recordException(err instanceof Error ? err : new Error(message));
        span.setStatus({ code: SpanStatusCode.ERROR, message });
        transport.send({
          type: 'error',
          error: err instanceof Error ? err.message : 'Send failed',
        });
        if (delivery?.awaitStartupAdmission && err instanceof ExecutionAdmissionError) throw err;
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
): Promise<void> {
  return withSpanAsync(
    'ws.interrupt',
    { 'ws.connectionId': connectionId, 'ws.sessionId': msg.sessionId },
    async () => {
      const found = ctx.sessionRegistry.findBySessionId(msg.sessionId);
      if (!found) return;

      const activeClientId = found.clientId;
      const storedAccountId = ctx.eventStore.getSession(msg.sessionId)?.accountBinding?.accountId;
      const storeState = ctx.eventStore.getSessionState(msg.sessionId);

      // Phase 2: detect state mismatches (observability only)
      const mismatch = detectStateMismatch(msg.sessionId, ctx.sessionRegistry, ctx.eventStore);
      if (mismatch.mismatch) {
        log.error('session state mismatch detected (interrupt)', {
          connectionId,
          sessionId: msg.sessionId,
          storeState,
          registryHas: true,
          details: mismatch.details,
        });
      }

      // State-based routing (Phase 3): durable state is the single source of truth.
      // ACTIVE/DETACHED/SUSPENDED → running path (interrupt existing query loop)
      // CLOSING/ENDED/null → resume path (zombie cleanup first if needed)
      if (
        found &&
        isActive(found.clientId) &&
        storeState !== 'ENDED' &&
        storeState !== 'CLOSING' &&
        storeState !== null
      ) {
        if (msg.accountId) {
          try {
            assertActiveAccountIdentity(ctx, msg.sessionId, msg.accountId);
          } catch (error: unknown) {
            transport.send({
              type: 'error',
              sessionId: msg.sessionId,
              error: error instanceof Error ? error.message : 'Account binding mismatch',
            });
            return;
          }
        }
        const duplicate = preflightChatCommand(
          activeClientId,
          msg.prompt,
          msg.images,
          msg.contextBlocks,
          msg.clientMsgId,
          msg.accountId ? msg.model : undefined,
          msg.accountId ? msg.reasoningEffort : undefined,
        );
        const ownerConnection =
          found.session?.ownerConnectionId ?? getOwnerConnection(found.clientId);
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
          if (found.session) found.session.ownerConnectionId = connectionId;
          log.info('takeover on interrupt', {
            connectionId,
            sessionId: msg.sessionId,
            oldOwner: ownerConnection,
            newClientId: activeClientId,
            storeState,
          });
        } else if (isDetached) {
          reattachChat(found.clientId, transport);
          if (found.session) found.session.ownerConnectionId = connectionId;
        }

        ctx.connRegistry.watch(connectionId, msg.sessionId);
        ctx.connRegistry.setActive(connectionId, msg.sessionId);
        if (duplicate) {
          log.info('duplicate interrupt', { connectionId, sessionId: msg.sessionId });
          return;
        }
        await interruptChat(
          activeClientId,
          msg.prompt,
          msg.images,
          msg.contextBlocks,
          msg.clientMsgId,
          msg.accountId ? msg.model : undefined,
          msg.accountId ? msg.reasoningEffort : undefined,
        );
        log.info('interrupt', { connectionId, sessionId: msg.sessionId });
        return;
      }

      // Zombie — abort before resume.
      if (found && isActive(found.clientId)) {
        log.info('aborting zombie session before resume (interrupt)', {
          connectionId,
          sessionId: msg.sessionId,
          clientId: found.clientId,
          storeState,
        });
        stopChat(found.clientId);
      }

      const sessionClientId = `${connectionId}:${msg.sessionId}`;
      ctx.connRegistry.watch(connectionId, msg.sessionId);
      ctx.connRegistry.setActive(connectionId, msg.sessionId);
      startChat(transport, sessionClientId, msg.prompt, {
        resume: msg.sessionId,
        accountId: msg.accountId ?? storedAccountId,
        resumePermission: found.session?.mode
          ? {
              mode: effectivePermissionMode(found.session),
              revision: permissionRevision(ctx.eventStore, msg.sessionId),
            }
          : undefined,
        model: msg.model ?? found.session?.model,
        reasoningEffort: msg.reasoningEffort,
        images: msg.images,
        contextBlocks: msg.contextBlocks,
        clientMsgId: msg.clientMsgId,
        agentName: found.session?.agentName,
        telosTaskId: found.session?.telosTaskId,
      }).catch((err: unknown) =>
        transport.send({
          type: 'error',
          error: err instanceof Error ? err.message : 'Session startup failed',
        }),
      );
      log.info('interrupt_resume', { connectionId, sessionId: msg.sessionId });
    },
  );
}

const PERMISSION_RESPONSE_REJECTED_MESSAGE =
  'Permission response was invalid or expired. Review the prompt and try again.';

function sendPermissionResponseRejected(
  transport: SessionTransport | undefined,
  connectionId: string,
  permId: string,
  sessionId?: string,
) {
  try {
    transport?.send({
      type: 'permission_response_rejected',
      sessionId,
      permId,
      error: PERMISSION_RESPONSE_REJECTED_MESSAGE,
    });
  } catch (error) {
    log.warn('permission response error delivery failed', {
      connectionId,
      sessionId,
      permId,
      error,
    });
  }
}

export function handlePermissionResponseV2(
  connectionId: string,
  msg: PermissionMsg,
  ctx: V2HandlerContext,
): boolean {
  return withSpan(
    'ws.permission_response',
    {
      'ws.connectionId': connectionId,
      'ws.sessionId': msg.sessionId ?? '',
      'ws.permId': msg.permId,
    },
    () => {
      const resolved = resolvePending(
        msg.permId,
        msg.decision ?? 'deny',
        msg.answers,
        msg.sessionId,
      );
      if (!resolved) {
        sendPermissionResponseRejected(
          ctx.connRegistry.get(connectionId)?.transport,
          connectionId,
          msg.permId,
          msg.sessionId,
        );
      }
      log.info('permission_response', {
        connectionId,
        sessionId: msg.sessionId,
        permId: msg.permId,
      });
      return resolved;
    },
  );
}

// Serialize mode changes per live session, including requests from different watchers.
export interface ModeChangeResult {
  ok: boolean;
  applied: boolean;
  persisted: boolean;
  mode?: SetModeMsg['mode'];
  code?: 'not_found' | 'provider' | 'persistence' | 'session_changed';
  error?: string;
}
const pendingModeChanges = new WeakMap<object, Promise<unknown>>();

export function handleSetModeV2(
  connectionId: string,
  msg: SetModeMsg,
  ctx: V2HandlerContext,
): Promise<ModeChangeResult> {
  const found = ctx.sessionRegistry.findBySessionId(msg.sessionId);
  if (!found) {
    // Historical sessions have no runtime to update. Commit their next-launch
    // policy before acknowledging it, so resuming uses the selected mode.
    let previousMode: SetModeMsg['mode'] | undefined;
    try {
      const stored = ctx.eventStore.getSession(msg.sessionId);
      if (!stored) {
        throw new Error(`Session not found: ${msg.sessionId}`);
      }
      previousMode = stored.mode;
      ctx.eventStore.upsertSession({ sessionId: msg.sessionId, mode: msg.mode });
      recordPermissionChange(ctx.eventStore, msg.sessionId);
      const acknowledgement = { type: 'mode_changed', sessionId: msg.sessionId, mode: msg.mode };
      try {
        ctx.connRegistry.broadcast(msg.sessionId, acknowledgement);
        const connection = ctx.connRegistry.get(connectionId);
        if (!connection?.watchedSessions.has(msg.sessionId))
          connection?.transport.send(acknowledgement);
      } catch (err) {
        // Delivery failure cannot undo an already persisted permission update.
        log.warn('set_mode acknowledgement delivery failed', {
          connectionId,
          sessionId: msg.sessionId,
          err,
        });
      }
      return Promise.resolve({ ok: true, applied: true, persisted: true, mode: msg.mode });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn('set_mode for historical session failed', {
        connectionId,
        sessionId: msg.sessionId,
        error: reason,
      });
      try {
        ctx.connRegistry.get(connectionId)?.transport.send({
          type: 'error',
          sessionId: msg.sessionId,
          error: `Could not change permission mode: ${reason}`,
        });
      } catch (sendError) {
        log.warn('set_mode error delivery failed', {
          connectionId,
          sessionId: msg.sessionId,
          err: sendError,
        });
      }
      return Promise.resolve({
        ok: false,
        applied: false,
        persisted: false,
        mode: previousMode,
        code: previousMode === undefined ? 'not_found' : 'persistence',
        error: reason,
      });
    }
  }
  const transition = Symbol('permission mode change');
  found.session.pendingPermissionModes ??= new Map();
  found.session.pendingPermissionModes.set(transition, msg.mode);
  const previous = pendingModeChanges.get(found.session) ?? Promise.resolve();
  const update = previous.then(() =>
    withSpanAsync(
      'ws.set_mode',
      { 'ws.connectionId': connectionId, 'ws.sessionId': msg.sessionId, 'ws.mode': msg.mode },
      async (): Promise<ModeChangeResult> => {
        // A queued request must never mutate a replacement session.
        if (ctx.sessionRegistry.findBySessionId(msg.sessionId)?.session !== found.session)
          return {
            ok: false,
            applied: false,
            persisted: false,
            code: 'session_changed',
            error: 'Session changed during permission update',
          };
        try {
          const query = found.session.queryInstance;
          // A startup session has no provider runtime yet. Commit synchronously;
          // startup reads its current mode when constructing the SDK query.
          if (query?.setPermissionMode) await query.setPermissionMode(msg.mode);
          const current = ctx.sessionRegistry.findBySessionId(msg.sessionId);
          if (!current || current.session !== found.session)
            return {
              ok: false,
              applied: false,
              persisted: false,
              code: 'session_changed',
              error: 'Session changed during permission update',
            };
          ctx.sessionRegistry.setMode(current.clientId, msg.mode);
          let persistenceError: string | undefined;
          try {
            ctx.eventStore.upsertSession({ sessionId: msg.sessionId, mode: msg.mode });
            recordPermissionChange(ctx.eventStore, msg.sessionId);
          } catch (err) {
            persistenceError = err instanceof Error ? err.message : String(err);
            log.warn('set_mode persistence failed', {
              sessionId: msg.sessionId,
              error: persistenceError,
            });
          }
          ctx.connRegistry.broadcast(msg.sessionId, {
            type: 'mode_changed',
            sessionId: msg.sessionId,
            mode: msg.mode,
          });
          log.info('set_mode', { connectionId, sessionId: msg.sessionId, mode: msg.mode });
          if (persistenceError !== undefined) {
            try {
              ctx.connRegistry.get(connectionId)?.transport.send({
                type: 'error',
                sessionId: msg.sessionId,
                error: `Permission mode applied, but could not save it for future sessions: ${persistenceError}`,
              });
            } catch (err) {
              log.warn('set_mode persistence error delivery failed', {
                connectionId,
                sessionId: msg.sessionId,
                err,
              });
            }
          }
          return persistenceError === undefined
            ? { ok: true, applied: true, persisted: true }
            : {
                ok: false,
                applied: true,
                persisted: false,
                code: 'persistence',
                error: `Permission mode applied, but could not save it for future sessions: ${persistenceError}`,
              };
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          log.warn('set_mode failed', { connectionId, sessionId: msg.sessionId, error: reason });
          try {
            ctx.connRegistry.get(connectionId)?.transport.send({
              type: 'error',
              sessionId: msg.sessionId,
              error: `Could not change permission mode: ${reason}`,
            });
          } catch (sendError) {
            log.warn('set_mode error delivery failed', {
              connectionId,
              sessionId: msg.sessionId,
              err: sendError,
            });
          }
          return { ok: false, applied: false, persisted: false, code: 'provider', error: reason };
        }
      },
    ),
  );
  pendingModeChanges.set(found.session, update);
  return update.then((result) => {
    found.session.pendingPermissionModes?.delete(transition);
    if (pendingModeChanges.get(found.session) === update) pendingModeChanges.delete(found.session);
    const current = ctx.sessionRegistry.findBySessionId(msg.sessionId)?.session;
    return { ...result, ...(current ? { mode: effectivePermissionMode(current) } : {}) };
  });
}

/** Legacy sockets are not registered v2 connections; deliver the shared result directly. */
export async function handleLegacySetMode(
  clientId: string,
  transport: SessionTransport,
  mode: SetModeMsg['mode'],
  ctx: V2HandlerContext,
): Promise<ModeChangeResult> {
  const sessionId = ctx.sessionRegistry.get(clientId)?.sessionId;
  const result: ModeChangeResult = sessionId
    ? await handleSetModeV2(clientId, { type: 'set_mode', sessionId, mode }, ctx)
    : {
        ok: false,
        applied: false,
        persisted: false,
        code: 'not_found',
        error:
          'Session is still starting or unavailable; retry the permission change once it is ready',
      };
  try {
    if (result.applied && result.mode)
      transport.send({ type: 'mode_changed', sessionId, mode: result.mode });
    if (!result.ok)
      transport.send({
        type: 'error',
        ...(sessionId ? { sessionId } : {}),
        error: result.error ?? 'Could not change permission mode',
      });
  } catch (err) {
    log.warn('legacy set_mode result delivery failed', { clientId, sessionId, err });
  }
  return result;
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

        const ownerConnection =
          found.session?.ownerConnectionId ?? getOwnerConnection(found.clientId);
        if (ownerConnection !== connectionId) {
          log.warn('suspend: not owner', {
            connectionId,
            sessionId: entry.sessionId,
            owner: ownerConnection,
          });
          continue;
        }

        ctx.sessionRegistry.suspend(found.clientId, entry.lastSeq);
        ctx.eventStore.setSessionState(entry.sessionId, 'SUSPENDED', {
          clientId: found.clientId,
          reason: 'ios_background',
        });
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

export function handleSessionClose(
  connectionId: string,
  msg: SessionCloseMsg,
  ctx: V2HandlerContext,
): void {
  withSpan(
    'ws.session_close',
    { 'ws.connectionId': connectionId, 'ws.sessionId': msg.sessionId },
    () => {
      const found = ctx.sessionRegistry.findBySessionId(msg.sessionId);
      const conn = ctx.connRegistry.get(connectionId);

      if (!found) {
        log.warn('close: session not found', { connectionId, sessionId: msg.sessionId });
        conn?.transport.send({
          type: 'session_close_ack',
          sessionId: msg.sessionId,
          accepted: false,
          reason: 'Session not found',
        });
        return;
      }

      const ownerConnection =
        found.session?.ownerConnectionId ?? getOwnerConnection(found.clientId);
      if (ownerConnection !== connectionId) {
        log.warn('close: not owner', {
          connectionId,
          sessionId: msg.sessionId,
          owner: ownerConnection,
        });
        conn?.transport.send({
          type: 'session_close_ack',
          sessionId: msg.sessionId,
          accepted: false,
          reason: 'Not session owner',
        });
        return;
      }

      closeSessionByUser(found.clientId);
      log.info('session close initiated by user', {
        connectionId,
        sessionId: msg.sessionId,
        clientId: found.clientId,
      });

      conn?.transport.send({
        type: 'session_close_ack',
        sessionId: msg.sessionId,
        accepted: true,
      });
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
    const candidate = parsed as Record<string, unknown>;
    if (candidate?.type === 'permission_response' && typeof candidate.permId === 'string')
      sendPermissionResponseRejected(
        transport,
        connectionId,
        candidate.permId,
        typeof candidate.sessionId === 'string' ? candidate.sessionId : undefined,
      );
    log.debug('unrecognized v2 message', {
      connectionId,
      type: candidate?.type,
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
    case 'session_close':
      handleSessionClose(connectionId, msg, ctx);
      break;
    case 'send':
      await handleSendV2(connectionId, transport, msg, ctx);
      break;
    case 'stop':
      handleStopV2(connectionId, msg, ctx);
      break;
    case 'interrupt':
      await handleInterruptV2(connectionId, transport, msg, ctx);
      break;
    case 'permission_response':
      handlePermissionResponseV2(connectionId, msg, ctx);
      break;
    case 'set_mode':
      await handleSetModeV2(connectionId, msg, ctx);
      break;
  }
}

/**
 * Keep ordinary messages in receive order, while allowing controls that can
 * break a stalled provider admission to run immediately.
 */
export function scheduleV2Message(
  chain: Promise<void>,
  connectionId: string,
  transport: SessionTransport,
  raw: string,
  ctx: V2HandlerContext,
  onError: (error: unknown) => void,
): Promise<void> {
  let isControl = false;
  try {
    const rawMessage = JSON.parse(raw) as Record<string, unknown>;
    const parsed = IncomingWsMessageV2.safeParse(rawMessage);
    isControl =
      rawMessage.type === 'permission_response' ||
      (parsed.success && (parsed.data.type === 'stop' || parsed.data.type === 'interrupt'));
  } catch {
    // Malformed messages stay on the ordinary FIFO and are ignored by dispatch.
  }

  const dispatch = () => dispatchV2Message(connectionId, transport, raw, ctx);
  if (isControl) {
    void dispatch().catch(onError);
    return chain;
  }
  return chain.then(dispatch).catch(onError);
}
