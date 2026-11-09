import { Router, type Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { TelosRuntimeStore } from './telos-runtime-store.js';
import { TelosWorkError } from './telos-work-store.js';

function failure(res: Response, error: unknown) {
  const status =
    error instanceof z.ZodError
      ? 400
      : error instanceof TelosWorkError
        ? { invalid: 400, unauthorized: 403, conflict: 409, not_found: 404 }[error.code]
        : 503;
  res.status(status).json({
    ok: false,
    error:
      error instanceof TelosWorkError
        ? error.message
        : status === 400
          ? 'Invalid Telos input'
          : 'Telos storage unavailable',
  });
}
function withStore(
  path: string,
  action: (store: TelosRuntimeStore) => void,
  assertCurrentSync: () => void,
) {
  const store = new TelosRuntimeStore(path, { assertCurrentSync });
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
      withStore(
        options.dbPath(),
        (store) => res.json(store.importSources(req.body)),
        () => {
          if (options.token() !== token)
            throw new TelosWorkError('unauthorized', 'Telos import authority changed');
        },
      );
    } catch (error) {
      failure(res, error);
    }
  });
  return router;
}
