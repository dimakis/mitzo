import { Router } from 'express';
import type { AccountBinding } from '@mitzo/protocol';
import type { CodexConversationStore } from './codex-conversation-store.js';

interface Dependencies {
  binding(sessionId: string): AccountBinding | undefined;
  overview(
    sessionId: string,
    binding: AccountBinding,
  ): ReturnType<CodexConversationStore['queueOverview']>;
  cancel(
    sessionId: string,
    binding: AccountBinding,
    commandId: string,
  ): 'cancelled' | 'not_queued' | 'not_found';
}
/** Mounted after application authentication. Only saved, unclaimed work can be cancelled. */
export function createCodexQueueRouter(deps: Dependencies) {
  const router = Router();
  router.get('/:id/codex-queue', (req, res) => {
    const binding = deps.binding(req.params.id);
    if (!binding) {
      res.status(404).json({ error: 'Codex conversation not found' });
      return;
    }
    try {
      res.json(deps.overview(req.params.id, binding));
    } catch {
      res.status(409).json({ error: 'Cannot read this queue. Check the conversation account.' });
    }
  });
  router.post('/:id/codex-queue/:commandId/cancel', (req, res) => {
    const binding = deps.binding(req.params.id);
    if (!binding) {
      res.status(404).json({ error: 'Codex conversation not found' });
      return;
    }
    try {
      const result = deps.cancel(req.params.id, binding, req.params.commandId);
      if (result === 'not_found') {
        res.status(404).json({ error: 'Queued message not found' });
        return;
      }
      if (result === 'not_queued') {
        res.status(409).json({
          error: 'This message has already started and cannot be cancelled from the queue.',
        });
        return;
      }
      res.json({ ok: true, status: 'cancelled' });
    } catch {
      res
        .status(409)
        .json({ error: 'Cannot cancel this message. Check the conversation account.' });
    }
  });
  return router;
}
