import { Router, type Response } from 'express';
import { z, ZodError } from 'zod';
import { SessionTimerCreateSchema, SessionTimerChangeSchema } from '@mitzo/protocol';
import { isAuthSessionCurrent, type AuthSession } from './auth.js';
import { requireSameOriginJson } from './connections-router.js';
import { SessionPromptError } from './session-prompt-store.js';
import type { SessionPromptService } from './session-prompt-service.js';

const id = z.string().min(1).max(200).regex(/^\S+$/);
export function createSessionPromptRouter(service: SessionPromptService) {
  const router = Router();
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    const auth = res.locals.authSession as AuthSession | undefined;
    if (!auth || !isAuthSessionCurrent(auth))
      return res.status(403).json({ error: 'Sign in to manage session timers.' });
    next();
  });
  const act = async (res: Response, action: (auth: AuthSession) => unknown, status = 200) => {
    try {
      const auth = res.locals.authSession as AuthSession;
      if (!isAuthSessionCurrent(auth))
        throw new SessionPromptError('Session authorization expired.', 403);
      const value = await action(auth);
      if (!isAuthSessionCurrent(auth))
        throw new SessionPromptError('Session authorization expired.', 403);
      res.status(status).json(value);
    } catch (error) {
      const status =
        error instanceof SessionPromptError ? error.status : error instanceof ZodError ? 400 : 503;
      res.status(status).json({
        error:
          status === 503
            ? 'Timers are temporarily unavailable.'
            : error instanceof Error
              ? error.message
              : 'Invalid timer request.',
      });
    }
  };
  router.get('/sessions', (_req, res) => act(res, (auth) => service.sessions(auth)));
  router.get('/', (req, res) =>
    act(res, () =>
      service.list(req.query.sessionId === undefined ? undefined : id.parse(req.query.sessionId)),
    ),
  );
  router.post('/', requireSameOriginJson, (req, res) =>
    act(
      res,
      (auth) => service.create(SessionTimerCreateSchema.parse(req.body), auth, 'user', null),
      201,
    ),
  );
  router.post('/:id', requireSameOriginJson, (req, res) =>
    act(res, (auth) =>
      service.change(id.parse(req.params.id), SessionTimerChangeSchema.parse(req.body), auth),
    ),
  );
  return router;
}
