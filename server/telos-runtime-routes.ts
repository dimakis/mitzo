import { Router, type Request, type Response, type RequestHandler } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { TelosWorkLifecycleListSchema } from '@mitzo/protocol';
import { TodoListResponse } from './api-schemas.js';
import { TelosRuntimeStore } from './telos-runtime-store.js';
import { TelosWorkError } from './telos-work-store.js';

function failure(res: Response, error: unknown) {
  const status =
    error instanceof z.ZodError
      ? 400
      : error instanceof TelosWorkError
        ? { invalid: 400, unauthorized: 403, conflict: 409, not_found: 404 }[error.code]
        : 503;
  res
    .status(status)
    .json({
      ok: false,
      error:
        error instanceof TelosWorkError
          ? error.message
          : status === 400
            ? 'Invalid Telos input'
            : 'Telos storage unavailable',
    });
}
function withStore(path: string, action: (store: TelosRuntimeStore) => void) {
  const store = new TelosRuntimeStore(path);
  try {
    action(store);
  } finally {
    store.close();
  }
}
/** Dedicated import credential is independent of operator cookies and agent tokens.
 * Mount before the general /api authentication; it accepts no other operations. */
export function createTelosImportRouter(options: {
  dbPath(): string;
  token(): string | undefined;
}) {
  const router = Router();
  router.post('/api/telos/import', (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const token = options.token();
    const supplied = req.headers.authorization?.replace(/^Bearer /, '');
    const hash = (s: string) => createHash('sha256').update(s).digest();
    if (!token || token.length < 32 || !supplied || !timingSafeEqual(hash(token), hash(supplied))) {
      res.status(401).json({ ok: false, error: 'Telos import credential required' });
      return;
    }
    try {
      withStore(options.dbPath(), (store) => res.json(store.importSources(req.body)));
    } catch (error) {
      failure(res, error);
    }
  });
  return router;
}

/** The application supplies its existing authentication and lifecycle projection.
 * No workspace script, source refresh, or alternate database fallback is used. */
export function createTelosTodoRouter(options: {
  dbPath(): string;
  operatorAuth: RequestHandler;
  project(
    canonical: z.output<typeof TodoListResponse>,
    view: 'active' | 'archive' | 'trash',
    req: Request,
    res: Response,
  ): unknown;
  assertCurrent?(req: Request, res: Response): void;
}) {
  const router = Router();
  router.get(
    '/api/todos',
    (req, res, next) => {
      const view = TelosWorkLifecycleListSchema.safeParse(req.query.view ?? 'active');
      if (!view.success) {
        res.status(400).json({ error: 'Invalid lifecycle view' });
        return;
      }
      return view.data === 'active' ? next() : options.operatorAuth(req, res, next);
    },
    (req, res) => {
      res.setHeader('Cache-Control', 'private, no-store');
      if (req.query.refresh === 'true') {
        res
          .status(400)
          .json({
            code: 'source_refresh_not_supported',
            error: 'This endpoint only reloads saved Telos items.',
          });
        return;
      }
      if (req.query.profile !== undefined && typeof req.query.profile !== 'string') {
        res.status(400).json({ error: 'Invalid profile' });
        return;
      }
      try {
        const view = TelosWorkLifecycleListSchema.parse(req.query.view ?? 'active');
        withStore(options.dbPath(), (store) => {
          store.renewSnoozes();
          const canonical = TodoListResponse.parse(
            store.list(req.query.profile as string | undefined, view !== 'active'),
          );
          res.json(options.project(canonical, view, req, res));
        });
      } catch (error) {
        failure(res, error);
      }
    },
  );
  router.post('/api/todos', options.operatorAuth, (req, res) => {
    try {
      withStore(options.dbPath(), (store) => {
        options.assertCurrent?.(req, res);
        res.status(201).json(store.create(req.body));
      });
    } catch (error) {
      failure(res, error);
    }
  });
  router.post('/api/todos/outcomes', options.operatorAuth, (req, res) => {
    try {
      withStore(options.dbPath(), (store) => {
        const receipt = store.createOutcome(req.body, () => options.assertCurrent?.(req, res));
        res.status(receipt.created ? 201 : 200).json(receipt);
      });
    } catch (error) {
      failure(res, error);
    }
  });
  router.post('/api/todos/:id/action', options.operatorAuth, (req, res) => {
    try {
      withStore(options.dbPath(), (store) => {
        options.assertCurrent?.(req, res);
        res.json(store.action(String(req.params.id), req.body));
      });
    } catch (error) {
      failure(res, error);
    }
  });
  return router;
}
