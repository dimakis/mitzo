import type { Request, Response } from 'express';
import { z } from 'zod';
import type { EventStore } from './event-store.js';

const updateSchema = z.intersection(
  z.object({ expectedRevision: z.number().int().nonnegative() }),
  z.union([
    z.object({ readReplySeq: z.number().int().nonnegative() }),
    z.object({ markedUnread: z.literal(true) }),
  ]),
);

export function createConversationReadHandlers(
  store: Pick<EventStore, 'getSession' | 'getSessionReadState' | 'setSessionReadState'>,
  broadcast: (id: string, state: ReturnType<EventStore['getSessionReadState']>) => void,
  diagnostic: (fields: { code: string; stage: string; sessionId: string }, cause: unknown) => void,
) {
  const handle = (write: boolean) => (req: Request<{ id: string }>, res: Response) => {
    const sessionId = req.params.id;
    try {
      const session = store.getSession(sessionId);
      if (!session || session.isHidden) {
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }
      if (!write) {
        res.json(store.getSessionReadState(sessionId));
        return;
      }
      const parsed = updateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid read-state update' });
        return;
      }
      const state = store.setSessionReadState(sessionId, parsed.data);
      broadcast(sessionId, state);
      res.json(state);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '';
      if (message === 'Read state changed') {
        res
          .status(409)
          .json({ error: 'Read state changed. Try again.', code: 'read_state_changed' });
      } else if (message === 'Invalid reply cursor') {
        res.status(400).json({ error: 'Invalid reply cursor' });
      } else {
        diagnostic(
          { code: 'conversation_read_failed', stage: write ? 'save' : 'load', sessionId },
          cause,
        );
        res.status(503).json({
          error: 'Couldn’t update conversation read status. Try again.',
          code: 'conversation_read_failed',
        });
      }
    }
  };
  return { get: handle(false), put: handle(true) };
}
