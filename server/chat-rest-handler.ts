// HTTP POST endpoints for chat operations — thin wrappers around ws-handler-v2.

import { Router } from 'express';
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

  router.post('/send', (req, res) => {
    const connectionId = getConnectionId(req, res);
    if (!connectionId) return;
    const transport = getTransport(connectionId, sseRegistry, ctx.connRegistry, res);
    if (!transport) return;
    const msg = validateBody(V2SendMessage, req.body, res);
    if (!msg) return;
    try {
      handleSendV2(connectionId, transport, msg, ctx);
      res.status(202).json({ ok: true });
    } catch (err) {
      log.error('POST /chat/send failed', { connectionId, error: String(err) });
      res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  });

  router.post('/interrupt', (req, res) => {
    const connectionId = getConnectionId(req, res);
    if (!connectionId) return;
    const transport = getTransport(connectionId, sseRegistry, ctx.connRegistry, res);
    if (!transport) return;
    const msg = validateBody(V2InterruptMessage, req.body, res);
    if (!msg) return;
    try {
      handleInterruptV2(connectionId, transport, msg, ctx);
      res.status(202).json({ ok: true });
    } catch (err) {
      log.error('POST /chat/interrupt failed', { connectionId, error: String(err) });
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
    const msg = validateBody(V2PermissionResponseMessage, req.body, res);
    if (!msg) return;
    try {
      handlePermissionResponseV2(connectionId, msg, ctx);
      res.json({ ok: true });
    } catch (err) {
      log.error('POST /chat/permission failed', { connectionId, error: String(err) });
      res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  });

  router.post('/mode', (req, res) => {
    const connectionId = getConnectionId(req, res);
    if (!connectionId) return;
    if (!requireConnection(connectionId, ctx.connRegistry, res)) return;
    const msg = validateBody(V2SetModeMessage, req.body, res);
    if (!msg) return;
    try {
      handleSetModeV2(connectionId, msg, ctx);
      res.json({ ok: true });
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
