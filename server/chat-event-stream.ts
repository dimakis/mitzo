import type { Express } from 'express';
import { bindAgentLibraryTransport } from './agent-library-transport.js';
import { registerAuthSession, type AuthSession } from './auth.js';
import { detachChatIfCurrentTransport } from './chat.js';
import { createLogger } from './logger.js';
import type { SessionSseRegistry } from './session-sse-registry.js';
import { SseTransport } from './sse-transport.js';
import { withSpan } from './tracing.js';
import {
  claimTransportConnection,
  releaseTransportConnection,
} from './transport-auth-ownership.js';
import type { V2HandlerContext } from './ws-handler-v2.js';

const log = createLogger('server');

/** Original production chat stream; mount after the application's existing auth
 * middleware with its SAME stream/connection/session owners. No listener,
 * bootstrap, session, provider or account is created by installation.
 */
export function mountApplicationChatEventStream(
  application: Express,
  sseRegistry: SessionSseRegistry,
  ctx: Pick<V2HandlerContext, 'connRegistry' | 'sessionRegistry'>,
): void {
  application.get('/api/chat/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const connectionId = `conn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const transport = new SseTransport(connectionId, sseRegistry);
    const authSession = res.locals.authSession as AuthSession | undefined;

    sseRegistry.add(connectionId, res, authSession?.id);
    const releaseLibrary = authSession
      ? bindAgentLibraryTransport(connectionId, authSession)
      : () => undefined;
    if (authSession) claimTransportConnection(connectionId, authSession.id);
    ctx.connRegistry.register(connectionId, transport);
    let cleaned = false;
    let unregisterAuth: () => void = () => undefined;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      releaseLibrary();
      unregisterAuth();
      if (authSession) releaseTransportConnection(connectionId, authSession.id);
      sseRegistry.remove(connectionId);

      const conn = ctx.connRegistry.get(connectionId);
      const watchedSessions = conn ? [...conn.watchedSessions] : [];

      ctx.connRegistry.remove(connectionId);
      ctx.sessionRegistry.removeObserver(transport);

      withSpan('sse.disconnect', { 'sse.connectionId': connectionId }, () => {
        for (const sessionId of watchedSessions) {
          const found = ctx.sessionRegistry.findBySessionId(sessionId);
          if (!found) continue;

          if (ctx.sessionRegistry.isSuspended(found.clientId)) {
            log.info('SSE closed for suspended session (expected)', { connectionId, sessionId });
            continue;
          }

          if (detachChatIfCurrentTransport(found.clientId, transport)) {
            log.info('SSE session detached (surviving)', { connectionId, sessionId });
          }
        }
      });

      log.info('SSE chat stream disconnected', { connectionId });
    };
    req.on('close', cleanup);
    unregisterAuth = authSession
      ? registerAuthSession(authSession, (reason) => {
          sseRegistry.sendTo(connectionId, { type: 'auth_expired', reason });
          res.end();
          cleanup();
        })
      : () => undefined;
    if (cleaned) {
      unregisterAuth();
      return;
    }

    // Send welcome with connectionId — client uses this in X-Connection-ID header on POSTs
    sseRegistry.sendTo(connectionId, {
      type: 'welcome',
      protocolVersion: 2,
      connectionId,
      eventAckBatchSize: 50,
    });

    // Reconnect is handled via POST /api/chat/reconnect — the client sends
    // a reconnect POST on every welcome event. The old ?sessions= query param
    // path was removed because EventSource auto-reconnect reuses the original
    // URL (without the param), making it unreliable.

    log.info('SSE chat stream connected', { connectionId });
  });
}
