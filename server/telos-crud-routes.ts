import { Router, type RequestHandler, type Request, type Response } from 'express';
import type { z } from 'zod';
import { TodoCreateBody, TodoOutcomeCreateBody, TodoActionBody } from './api-schemas.js';
import { MitzoTelosStore } from './telos-native-store.js';
import { TelosWorkError } from './telos-work-store.js';
import { TelosWorkLifecycleListSchema } from '@mitzo/protocol';
import { TelosCollectionWakeupRequired } from './telos-snooze.js';
import { createLogger } from './logger.js';

export function createTelosCrudRouter(options: {
  databasePath(): string;
  operatorAuth: RequestHandler;
}) {
  const router = Router();
  const execute = (
    res: Response,
    operation: (store: MitzoTelosStore) => void,
    readOnly = false,
  ) => {
    // Retry only an explicitly observed due-snooze transition with a writer.
    for (let attempt = 0; attempt < 2; attempt++) {
      let store: MitzoTelosStore | undefined;
      try {
        store = new MitzoTelosStore(options.databasePath(), { readOnly });
        operation(store);
        return;
      } catch (error) {
        if (readOnly && error instanceof TelosCollectionWakeupRequired) {
          readOnly = false;
          continue;
        }
        const message = error instanceof Error ? error.message : '';
        const status =
          error instanceof TelosWorkError
            ? { invalid: 400, unauthorized: 403, conflict: 409, not_found: 404 }[error.code]
            : /not found/.test(message)
              ? 404
              : /Unfinished|identity|changed;|Historical/.test(message)
                ? 409
                : 503;
        if (status === 503) {
          const code =
            error instanceof Error &&
            'code' in error &&
            typeof error.code === 'string' &&
            /^SQLITE_[A-Z_]+$/.test(error.code)
              ? error.code
              : 'STORAGE_UNAVAILABLE';
          createLogger('telos-crud').warn('Canonical Telos request failed', { code });
        }
        res.status(status).json({
          ok: false,
          error:
            status === 503
              ? 'Telos storage unavailable; retry after checking the server diagnostics.'
              : message,
        });
        return;
      } finally {
        store?.close();
      }
    }
  };
  router.get('/api/todos', (req, res) => {
    if (req.query.refresh === 'true')
      return void res.status(400).json({
        code: 'source_refresh_not_supported',
        error: 'This endpoint only reloads saved Telos items.',
      });
    if (req.query.profile !== undefined && typeof req.query.profile !== 'string')
      return void res.status(400).json({ error: 'Invalid profile' });
    const view = TelosWorkLifecycleListSchema.safeParse(req.query.view ?? 'active');
    if (!view.success)
      return void res.status(400).json({ code: 'invalid', error: 'Invalid lifecycle view' });
    const read = () =>
      execute(
        res,
        (store) => res.json(store.list(req.query.profile as string | undefined, view.data)),
        true,
      );
    if (view.data === 'active') read();
    else options.operatorAuth(req, res, read);
  });
  const mutation = <T extends z.ZodType>(
    path: string,
    schema: T,
    operation: (store: MitzoTelosStore, input: z.output<T>, req: Request, res: Response) => unknown,
  ) => {
    router.post(path, options.operatorAuth, (req, res) => {
      const input = schema.safeParse(req.body);
      if (!input.success)
        return void res
          .status(400)
          .json({ ok: false, error: input.error.issues[0]?.message ?? 'Invalid input' });
      execute(res, (store) => {
        operation(store, input.data, req, res);
      });
    });
  };
  mutation('/api/todos', TodoCreateBody, (store, input, _req, res) =>
    res.status(201).json(store.create(input.summary, input.profile, input.parentId)),
  );
  mutation('/api/todos/outcomes', TodoOutcomeCreateBody, (store, input, _req, res) => {
    const result = store.createOutcome(input);
    res.status(result.created ? 201 : 200).json(result);
  });
  mutation('/api/todos/:id/action', TodoActionBody, (store, input, req, res) =>
    res.json(store.action(String(req.params.id), input, String(res.locals.authSession.id))),
  );
  return router;
}
