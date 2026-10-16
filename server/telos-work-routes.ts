import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import {
  TelosWorkCommandSchema,
  TelosWorkIdSchema,
  TelosSourceConversationReferenceSchema,
} from '@mitzo/protocol';
import { TelosWorkStore, TelosWorkError, type TelosWorkActor } from './telos-work-store.js';

/** Operator mutations and scoped conversation reads share the same durable
 * store. Internal tokens are not operator authority. No route accepts a caller
 * actor, allocator receipt, provider/client binding or model launch command.
 */
export function createTelosWorkRouter(options: {
  dbPath(): string;
  operatorAuth: RequestHandler;
  verifyInternal(req: Request): boolean;
  sessionId(clientId: string): string | undefined;
  ordinaryConversation(id: string): boolean;
}) {
  const router = Router();
  router.use(['/api/telos/work', '/api/internal/telos/work'], (_req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    next();
  });
  const run = (res: Response, action: (store: TelosWorkStore) => unknown) => {
    let store: TelosWorkStore | undefined;
    try {
      store = new TelosWorkStore(options.dbPath(), {
        ordinaryConversation: options.ordinaryConversation,
      });
      res.json(action(store));
    } catch (error) {
      const known = error instanceof TelosWorkError;
      const constraint =
        error instanceof Error && 'code' in error && error.code === 'SQLITE_CONSTRAINT_TRIGGER';
      const status = known
        ? { not_found: 404, unauthorized: 403, conflict: 409, invalid: 400 }[error.code]
        : constraint
          ? 400
          : error instanceof z.ZodError
            ? 400
            : 503;
      res.status(status).json({
        code: known ? error.code : status === 400 ? 'invalid' : 'unavailable',
        error: known
          ? error.message
          : constraint
            ? 'Invalid work composition'
            : status === 400
              ? 'Invalid work input'
              : 'Telos work service unavailable',
      });
    } finally {
      store?.close();
    }
  };
  const actor = (res: Response): TelosWorkActor | undefined => {
    const id: unknown = res.locals.authSession?.id;
    if (typeof id !== 'string' || !id.trim()) {
      res
        .status(403)
        .json({ code: 'unauthorized', error: 'Interactive operator authentication required' });
      return;
    }
    return { kind: 'operator', id };
  };
  router.get('/api/telos/work/items/:itemId', options.operatorAuth, (req, res) => {
    const authority = actor(res);
    if (!authority) return;
    const id = TelosWorkIdSchema.safeParse(req.params.itemId);
    if (!id.success) {
      res.status(400).json({ code: 'invalid', error: 'Invalid work item ID' });
      return;
    }
    run(res, (store) => store.read(id.data, authority));
  });
  router.post('/api/telos/work/commands', options.operatorAuth, (req, res) => {
    const authority = actor(res);
    if (!authority) return;
    const input = TelosWorkCommandSchema.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ code: 'invalid', error: 'Invalid work command' });
      return;
    }
    run(res, (store) => store.execute(input.data, authority));
  });
  router.post('/api/telos/work/links', options.operatorAuth, (req, res) => {
    const authority = actor(res);
    if (!authority) return;
    const input = TelosSourceConversationReferenceSchema.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ code: 'invalid', error: 'Invalid conversation reference' });
      return;
    }
    run(res, (store) => store.forConversation(input.data, authority));
  });
  router.post('/api/internal/telos/work/read', (req, res) => {
    if (!options.verifyInternal(req)) {
      res.status(401).json({ code: 'unauthorized', error: 'Internal token required' });
      return;
    }
    const id = options.sessionId(String(req.headers['x-client-id'] ?? ''));
    if (!id) {
      res.status(409).json({ code: 'unavailable', error: 'Active Mitzo session required' });
      return;
    }
    const input = z.strictObject({ itemId: TelosWorkIdSchema }).safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ code: 'invalid', error: 'Invalid work read' });
      return;
    }
    run(res, (store) => store.read(input.data.itemId, { kind: 'conversation', id }));
  });
  return router;
}
