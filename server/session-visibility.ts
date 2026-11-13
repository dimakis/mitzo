import { Router, type RequestHandler } from 'express';
import { isRegisteredConversation } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import { requireSameOriginJson } from './connections-router.js';
import { createLogger } from './logger.js';

/** Visibility never releases a runtime, clears a removal fence, or grants new
 * workspace authority. Retained removed chats remain available as history. */
export function createSessionVisibilityRouter(deps: {
  events: Pick<
    EventStore,
    'getSession' | 'listHiddenSessions' | 'hideSession' | 'showSession' | 'removals'
  >;
  authorize: RequestHandler;
  changed(id: string): void;
}) {
  const router = Router();
  const log = createLogger('session-visibility');
  router.get('/hidden', deps.authorize, (req, res) => {
    try {
      const offset = Math.max(0, Number.parseInt(String(req.query.offset), 10) || 0);
      const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit), 10) || 20));
      const rows = deps.events.listHiddenSessions(limit + 1, offset);
      res.json({
        sessions: rows.slice(0, limit).map((session) => ({
          id: session.sessionId,
          summary: session.summary || session.initialPrompt || 'Untitled conversation',
          lastModified: session.updatedAt,
          resourcesReleased: deps.events.removals.read(session.sessionId)?.phase === 'completed',
          canRestore: !deps.events.removals.read(session.sessionId),
        })),
        hasMore: rows.length > limit,
      });
    } catch (error) {
      log.error('Hidden conversation listing failed', {
        err: error,
        code: 'hidden_chats_unavailable',
        stage: 'list',
      });
      res.status(503).json({
        error: 'Hidden chats are unavailable. Try again.',
        code: 'hidden_chats_unavailable',
      });
    }
  });
  router.post('/:id/visibility', deps.authorize, requireSameOriginJson, (req, res) => {
    const id = req.params.id;
    if (typeof id !== 'string' || typeof req.body?.hidden !== 'boolean')
      return res.status(400).json({ error: 'A conversation and visibility choice are required.' });
    try {
      const session = deps.events.getSession(id);
      if (!isRegisteredConversation(session))
        return res.status(404).json({ error: 'Chat not found.' });
      deps.events.removals.assertArchivable(id);
      if (!req.body.hidden && deps.events.removals.read(id))
        return res.status(409).json({
          error:
            'This chat has a resource removal record. View its saved history and review recovery before starting more work.',
          code: 'chat_recovery_required',
        });
      if (req.body.hidden) deps.events.hideSession(id);
      else deps.events.showSession(id);
      deps.changed(id);
      return res.json({ ok: true });
    } catch (error) {
      log.warn('Conversation visibility change failed', {
        err: error,
        sessionId: id,
        stage: 'visibility',
        code: 'chat_visibility_failed',
      });
      return res.status(409).json({
        error: 'Visibility could not be changed. Review any resource removal, then try again.',
        code: 'chat_visibility_failed',
      });
    }
  });
  return router;
}
