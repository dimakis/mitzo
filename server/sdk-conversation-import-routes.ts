import { Router } from 'express';
import { z } from 'zod';

export function createSdkConversationImportRouter(deps: {
  list(): Promise<unknown[]>;
  adopt(sessionId: string): Promise<{ sessionId: string } | null>;
}) {
  const router = Router();
  router.get('/importable', async (_req, res) => {
    try {
      res.json({ candidates: await deps.list() });
    } catch {
      res.status(500).json({ error: 'Could not find external conversations' });
    }
  });
  router.post('/import', async (req, res) => {
    const input = z.object({ sessionId: z.string().uuid() }).strict().safeParse(req.body);
    if (!input.success)
      return void res.status(400).json({ error: 'Select a conversation to import' });
    try {
      const conversation = await deps.adopt(input.data.sessionId);
      if (!conversation)
        return void res.status(404).json({ error: 'Conversation unavailable for import' });
      if (conversation.sessionId !== input.data.sessionId)
        throw new Error('Conversation import identity mismatch');
      res.json({ sessionId: conversation.sessionId });
    } catch {
      res.status(500).json({ error: 'Could not import this conversation' });
    }
  });
  return router;
}
