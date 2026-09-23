import {
  reasoningSessionId,
  isReasoningSessionId,
  paidReasoningCommand,
} from './reasoning-command-admission.js';

import { parseSlashCommand } from './slash-commands.js';
// HTTP POST endpoints for chat operations — thin wrappers around ws-handler-v2.

import { Router } from 'express';
import { isDeepStrictEqual } from 'node:util';
import { acceptSendCommandAsync } from './send-command.js';
import type { Request, Response } from 'express';
import {
  V2SendMessage,
  V2StopMessage,
  V2InterruptMessage,
  V2PermissionResponseMessage,
  V2SetModeMessage,
  WatchMessage,
  UnwatchMessage,
  SwitchSessionMessage,
  SessionSuspendMessage,
  SessionCloseMessage,
  ReconnectMessage,
} from '@mitzo/protocol';
import type { V2HandlerContext } from './ws-handler-v2.js';
import {
  handleSendV2,
  handleStopV2,
  handleInterruptV2,
  handlePermissionResponseV2,
  handleSetModeV2,
  handleWatch,
  handleUnwatch,
  handleSwitchSession,
  handleSessionSuspend,
  handleSessionClose,
  handleReconnect,
} from './ws-handler-v2.js';
import type { SessionSseRegistry } from './session-sse-registry.js';
import { SseTransport } from './sse-transport.js';
import { createLogger } from './logger.js';
import { ExecutionAdmissionError } from '@mitzo/protocol/event-store';

const log = createLogger('chat-rest');

function getConnectionId(req: Request, res: Response): string | null {
  const connectionId = req.headers['x-connection-id'] as string | undefined;
  if (!connectionId) {
    res.status(400).json({ ok: false, error: 'Missing X-Connection-ID header' });
    return null;
  }
  return connectionId;
}

function getTransport(
  connectionId: string,
  sseRegistry: SessionSseRegistry,
  connRegistry: V2HandlerContext['connRegistry'],
  res: Response,
): SseTransport | null {
  if (!sseRegistry.isOpen(connectionId)) {
    res.status(404).json({ ok: false, error: 'No SSE stream for this connection' });
    return null;
  }
  const authSessionId = res.locals.authSession?.id as string | undefined;
  if (authSessionId && !sseRegistry.isOwnedBy(connectionId, authSessionId)) {
    res.status(403).json({ ok: false, error: 'SSE connection belongs to another login' });
    return null;
  }
  const conn = connRegistry.get(connectionId);
  if (!conn) {
    res.status(404).json({ ok: false, error: 'Connection not registered' });
    return null;
  }
  return conn.transport as SseTransport;
}

/** Verify the connection exists in the registry. */
function requireConnection(
  connectionId: string,
  connRegistry: V2HandlerContext['connRegistry'],
  res: Response,
): boolean {
  if (!connRegistry.get(connectionId)) {
    res.status(404).json({ ok: false, error: 'Connection not registered' });
    return false;
  }
  return true;
}

function validateBody<T>(
  schema: { safeParse: (data: unknown) => { success: boolean; data?: T; error?: unknown } },
  body: unknown,
  res: Response,
): T | null {
  const result = schema.safeParse(body);
  if (!result.success) {
    res.status(400).json({ ok: false, error: 'Invalid request body', details: result.error });
    return null;
  }
  return result.data!;
}

export function createChatRestRouter(
  sseRegistry: SessionSseRegistry,
  ctx: V2HandlerContext,
): Router {
  const router = Router();

  // A connection ID is not a credential. Bind every operation targeting an
  // registered SSE stream to the same login session that created that stream.
  // Ownership survives the brief writableEnded→close-handler cleanup window.
  router.use((req, res, next) => {
    const connectionId = req.headers['x-connection-id'];
    const authSessionId = res.locals.authSession?.id as string | undefined;
    if (
      typeof connectionId === 'string' &&
      ctx.connRegistry.get(connectionId) &&
      !sseRegistry.has(connectionId)
    ) {
      res.status(403).json({ ok: false, error: 'REST operations require an SSE connection' });
      return;
    }
    if (
      typeof connectionId === 'string' &&
      authSessionId &&
      sseRegistry.has(connectionId) &&
      !sseRegistry.isOwnedBy(connectionId, authSessionId)
    ) {
      res.status(403).json({ ok: false, error: 'SSE connection belongs to another login' });
      return;
    }
    next();
  });

  router.post('/send', async (req, res) => {
    const msg = validateBody(V2SendMessage, req.body, res);
    if (!msg) return;
    const connectionId =
      (req.headers['x-connection-id'] as string | undefined) ?? `send-${msg.clientMsgId}`;
    try {
      const dispatch = async (
        command: typeof msg,
        sessionId: string,
        options: {
          preserveReceiptErrors?: boolean;
          preserveReceiptSession?: boolean;
          receiptAdmitted?: boolean;
        } = {},
      ) => {
        const delegate = new SseTransport(connectionId, sseRegistry);
        const transport = {
          // This transport accepts events into durable storage even offline.
          isOpen: () => true,
          send(data: Record<string, unknown>) {
            let event =
              data.type === 'native_command_result' && !command.sessionId
                ? data
                : { ...data, sessionId: data.sessionId ?? sessionId };
            if (data.type === 'error' && !options.preserveReceiptErrors) {
              ctx.eventStore.failSendCommand(command.clientMsgId, String(data.error));
            }
            // Query-loop events already carry their durable sequence. Early
            // startup metadata uses this boundary as its persistence point.
            if (event.sessionId && typeof event.seq !== 'number') {
              const durable = { ...event, v: 2 };
              const seq = ctx.eventStore.append(
                String(event.sessionId),
                String(event.type),
                durable,
              );
              event = { ...durable, seq };
            }
            if (ctx.connRegistry.hasOpenWatchers(sessionId))
              ctx.connRegistry.broadcast(sessionId, event);
            else delegate.send(event);
          },
        };
        const outcome = await handleSendV2(connectionId, transport, command, ctx, {
          initialSessionId: command.sessionId ? undefined : sessionId,
          awaitStartupAdmission: true,
          // REST inserts the global receipt before dispatch; WS inserts it in
          // handleSendV2 so the same check can fence cross-transport retries.
          receiptAdmitted: options.receiptAdmitted ?? true,
        });
        if (outcome === 'native') return options.preserveReceiptSession ? undefined : false;
      };
      const parsed = parseSlashCommand(msg.prompt);
      const paidReasoning = !!parsed && paidReasoningCommand(parsed.name, parsed.arguments);
      const admittedMessage =
        !paidReasoning &&
        msg.sessionId &&
        isReasoningSessionId(msg.sessionId) &&
        ctx.eventStore.getSessionState(msg.sessionId) === 'ENDED'
          ? { ...msg, sessionId: null }
          : msg;
      if (paidReasoning) {
        // Keep the global receipt as the command identity, while replaying an
        // exact receipt through the command's route/fingerprint gate. A
        // sessionless receipt uses the same deterministic ID as the native
        // admission, but the command remains sessionless to its transport.
        const sessionId = msg.sessionId ?? reasoningSessionId(parsed!.name, msg.clientMsgId);
        const receiptMessage = msg.sessionId ? msg : { ...msg, sessionId };
        const existingReceipt = ctx.eventStore.getSendCommand(msg.clientMsgId);
        if (existingReceipt && !isDeepStrictEqual(existingReceipt.payload, receiptMessage)) {
          throw new ExecutionAdmissionError(
            'fingerprint_conflict',
            'Command ID already admitted for a different request',
          );
        }
        const receipt = await acceptSendCommandAsync(
          ctx.eventStore,
          receiptMessage,
          async (command, admittedSessionId) => {
            await dispatch(
              msg.sessionId ? command : { ...command, sessionId: null },
              admittedSessionId,
              {
                preserveReceiptErrors: Boolean(existingReceipt),
                preserveReceiptSession: true,
                receiptAdmitted: true,
              },
            );
          },
          { replayExisting: true },
        );
        res.status(202).json(receipt);
      } else {
        const receipt = await acceptSendCommandAsync(ctx.eventStore, admittedMessage, dispatch);
        res.status(202).json(receipt);
      }
    } catch (err) {
      log.error('POST /chat/send failed', { connectionId, error: String(err) });
      if (err instanceof ExecutionAdmissionError) {
        res.status(409).json({
          ok: false,
          code: err.code,
          error: err.message,
          clientMsgId: msg.clientMsgId,
        });
        return;
      }
      res.status(422).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Send failed',
        clientMsgId: msg.clientMsgId,
      });
    }
  });

  // The HTTP response alone cannot establish SSE liveness.
  router.post('/probe', (req, res) => {
    const connectionId = getConnectionId(req, res);
    if (!connectionId) return;
    const transport = getTransport(connectionId, sseRegistry, ctx.connRegistry, res);
    if (!transport) return;
    const nonce = req.body?.nonce;
    if (typeof nonce !== 'string' || nonce.length > 100 || !nonce) {
      res.status(400).json({ ok: false });
      return;
    }
    transport.send({ type: '_probe', nonce });
    res.status(202).json({ ok: true });
  });

  router.post('/interrupt', async (req, res) => {
    const connectionId = getConnectionId(req, res);
    if (!connectionId) return;
    const transport = getTransport(connectionId, sseRegistry, ctx.connRegistry, res);
    if (!transport) return;
    const msg = validateBody(V2InterruptMessage, req.body, res);
    if (!msg) return;
    try {
      await handleInterruptV2(connectionId, transport, msg, ctx, {
        awaitStartupAdmission: true,
      });
      res.status(202).json({ ok: true });
    } catch (err) {
      log.error('POST /chat/interrupt failed', { connectionId, error: String(err) });
      if (err instanceof ExecutionAdmissionError) {
        res.status(409).json({ ok: false, code: err.code, error: err.message });
        return;
      }
      res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  });

  router.post('/stop', (req, res) => {
    const connectionId = getConnectionId(req, res);
    if (!connectionId) return;
    if (!requireConnection(connectionId, ctx.connRegistry, res)) return;
    const msg = validateBody(V2StopMessage, req.body, res);
    if (!msg) return;
    try {
      handleStopV2(connectionId, msg, ctx);
      res.json({ ok: true });
    } catch (err) {
      log.error('POST /chat/stop failed', { connectionId, error: String(err) });
      res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  });

  router.post('/permission', (req, res) => {
    const connectionId = getConnectionId(req, res);
    if (!connectionId) return;
    if (!requireConnection(connectionId, ctx.connRegistry, res)) return;
    const parsed = V2PermissionResponseMessage.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        type: 'permission_response_rejected',
        permId: typeof req.body?.permId === 'string' ? req.body.permId : '',
        error: 'Permission response was invalid or expired. Review the prompt and try again.',
      });
      return;
    }
    const msg = parsed.data;
    try {
      if (!handlePermissionResponseV2(connectionId, msg, ctx)) {
        res.status(409).json({
          ok: false,
          type: 'permission_response_rejected',
          permId: msg.permId,
          error: 'Permission response was invalid or expired. Review the prompt and try again.',
        });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      log.error('POST /chat/permission failed', { connectionId, error: String(err) });
      res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  });

  router.post('/mode', async (req, res) => {
    const connectionId = getConnectionId(req, res);
    if (!connectionId) return;
    if (!requireConnection(connectionId, ctx.connRegistry, res)) return;
    const msg = validateBody(V2SetModeMessage, req.body, res);
    if (!msg) return;
    try {
      const result = await handleSetModeV2(connectionId, msg, ctx);
      const status = result.ok
        ? 200
        : result.code === 'not_found'
          ? 404
          : result.code === 'persistence'
            ? 500
            : 409;
      res.status(status).json(result);
    } catch (err) {
      log.error('POST /chat/mode failed', { connectionId, error: String(err) });
      res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  });

  router.post('/watch', (req, res) => {
    const connectionId = getConnectionId(req, res);
    if (!connectionId) return;
    if (!requireConnection(connectionId, ctx.connRegistry, res)) return;
    const msg = validateBody(WatchMessage, req.body, res);
    if (!msg) return;
    try {
      handleWatch(connectionId, msg, ctx);
      res.json({ ok: true });
    } catch (err) {
      log.error('POST /chat/watch failed', { connectionId, error: String(err) });
      res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  });

  router.post('/unwatch', (req, res) => {
    const connectionId = getConnectionId(req, res);
    if (!connectionId) return;
    if (!requireConnection(connectionId, ctx.connRegistry, res)) return;
    const msg = validateBody(UnwatchMessage, req.body, res);
    if (!msg) return;
    try {
      handleUnwatch(connectionId, msg, ctx);
      res.json({ ok: true });
    } catch (err) {
      log.error('POST /chat/unwatch failed', { connectionId, error: String(err) });
      res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  });

  router.post('/switch', async (req, res) => {
    const connectionId = getConnectionId(req, res);
    if (!connectionId) return;
    if (!requireConnection(connectionId, ctx.connRegistry, res)) return;
    const msg = validateBody(SwitchSessionMessage, req.body, res);
    if (!msg) return;
    try {
      await handleSwitchSession(connectionId, msg, ctx);
      res.json({ ok: true });
    } catch (err) {
      log.error('POST /chat/switch failed', { connectionId, error: String(err) });
      res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  });

  router.post('/suspend', (req, res) => {
    const connectionId = getConnectionId(req, res);
    if (!connectionId) return;
    if (!requireConnection(connectionId, ctx.connRegistry, res)) return;
    const msg = validateBody(SessionSuspendMessage, req.body, res);
    if (!msg) return;
    try {
      handleSessionSuspend(connectionId, msg, ctx);
      res.json({ ok: true });
    } catch (err) {
      log.error('POST /chat/suspend failed', { connectionId, error: String(err) });
      res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  });

  router.post('/close', (req, res) => {
    const connectionId = getConnectionId(req, res);
    if (!connectionId) return;
    if (!requireConnection(connectionId, ctx.connRegistry, res)) return;
    const msg = validateBody(SessionCloseMessage, req.body, res);
    if (!msg) return;
    try {
      handleSessionClose(connectionId, msg, ctx);
      res.json({ ok: true });
    } catch (err) {
      log.error('POST /chat/close failed', { connectionId, error: String(err) });
      res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  });

  router.post('/reconnect', (req, res) => {
    const connectionId = getConnectionId(req, res);
    if (!connectionId) return;
    if (!requireConnection(connectionId, ctx.connRegistry, res)) return;
    const msg = validateBody(ReconnectMessage, req.body, res);
    if (!msg) return;
    try {
      handleReconnect(connectionId, msg, ctx);
      res.json({ ok: true });
    } catch (err) {
      log.error('POST /chat/reconnect failed', { connectionId, error: String(err) });
      res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  });

  return router;
}
