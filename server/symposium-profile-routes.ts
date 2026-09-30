import { Router, type Response } from 'express';
import { ZodError } from 'zod';
import type { SymposiumProfileStore, SymposiumProfileVersion } from './symposium-profiles.js';

// The current interactive JWT has a single verified subject (`user`). Its JTI
// identifies a login session, not a stable owner namespace.
const OWNER = 'user';

function failure(res: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  res
    .status(
      error instanceof ZodError
        ? 400
        : /not found/i.test(message)
          ? 404
          : /conflict|idempotency/i.test(message)
            ? 409
            : 400,
    )
    .json({ error: message });
}

/** Mount behind operatorAuthMiddleware; never accept owner identity from a request body. */
export function createSymposiumProfileRouter(store: SymposiumProfileStore): Router {
  const router = Router();
  router.use((_req, res, next) => {
    if (!res.locals.authSession)
      return res.status(403).json({ error: 'Interactive operator authentication is required' });
    next();
  });
  router.get('/', (_req, res) => {
    try {
      res.json(store.list(OWNER));
    } catch (error) {
      failure(res, error);
    }
  });
  router.post('/', (req, res) => {
    try {
      res.json(store.save(OWNER, req.body));
    } catch (error) {
      failure(res, error);
    }
  });
  router.post('/import', (req, res) => {
    try {
      res.json(
        store.import(
          OWNER,
          req.body?.artifact as SymposiumProfileVersion,
          req.body?.idempotencyKey,
        ),
      );
    } catch (error) {
      failure(res, error);
    }
  });
  router.get('/:profileId/:revision/export', (req, res) => {
    try {
      res.json(store.export(OWNER, req.params.profileId, Number(req.params.revision)));
    } catch (error) {
      failure(res, error);
    }
  });
  router.get('/:profileId/:revision', (req, res) => {
    try {
      const version = store.get(OWNER, req.params.profileId, Number(req.params.revision));
      if (!version) return res.status(404).json({ error: 'Profile revision not found' });
      res.json(version);
    } catch (error) {
      failure(res, error);
    }
  });
  return router;
}
