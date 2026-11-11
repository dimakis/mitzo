import express from 'express';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createLogger } from './logger.js';
import { recentAuthorizationSession, requireSameOriginJson } from './connections-router.js';
import { ClaudeAccountLogin } from './claude-account-login.js';
import {
  ClaudeAccountStore,
  ClaudeLoginInput,
  claudeAccountsDirectory,
} from './claude-account-store.js';

const log = createLogger('claude-account-router');
let host: ClaudeAccountLogin | undefined;
export function getClaudeAccountLogin() {
  if (process.platform !== 'darwin') return undefined;
  return (host ??= new ClaudeAccountLogin({
    store: new ClaudeAccountStore(claudeAccountsDirectory()),
  }));
}
export async function closeClaudeAccountLogin() {
  await host?.close();
  host = undefined;
}

/** Mount behind operatorAuthMiddleware, ahead of the application's large-body parser. */
export function createClaudeAccountRouter(
  resolveHost: () => ClaudeAccountLogin | undefined = getClaudeAccountLogin,
) {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (recentAuthorizationSession(res)) next();
  });
  router.use(
    rateLimit({
      windowMs: 60_000,
      limit: 90,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: 'Too many Claude account requests. Wait a minute and check status.' },
    }),
  );
  router.use((req, res, next) =>
    req.method === 'POST' ? requireSameOriginJson(req, res, next) : next(),
  );
  router.use(express.json({ limit: '6kb' }));
  const route =
    (
      operation: (
        req: express.Request,
        res: express.Response,
        service: ClaudeAccountLogin,
      ) => unknown,
    ) =>
    async (req: express.Request, res: express.Response) => {
      try {
        const service = resolveHost();
        if (!service)
          return req.method === 'GET' && req.path === '/'
            ? res.json({ enabled: false, accounts: [], attempts: [] })
            : res.status(503).json({ error: 'Claude subscription sign-in requires Local Mac.' });
        return await operation(req, res, service);
      } catch (cause) {
        const diagnosticId = randomUUID();
        log.warn('Claude account request failed', {
          stage: 'claude_account_request',
          code: 'CLAUDE_LOGIN_REQUEST_FAILED',
          diagnosticId,
          causeType: cause instanceof Error ? cause.name : 'unknown',
        });
        return res.status(cause instanceof z.ZodError ? 400 : 409).json({
          error: 'Claude sign-in could not be confirmed. Check status before retrying.',
          errorCode: 'CLAUDE_LOGIN_REQUEST_FAILED',
          diagnosticId,
        });
      }
    };
  router.get(
    '/',
    route((_req, res, service) => res.json(service.list(res.locals.authSession))),
  );
  router.post(
    '/start',
    route(async (req, res, service) =>
      res.json(await service.start(res.locals.authSession, ClaudeLoginInput.parse(req.body))),
    ),
  );
  router.get(
    '/:id',
    route((req, res, service) =>
      res.json(service.status(res.locals.authSession, z.uuid().parse(req.params.id))),
    ),
  );
  router.post(
    '/:id/code',
    route(async (req, res, service) => {
      const { code } = z.strictObject({ code: z.string().min(1).max(4096) }).parse(req.body);
      // Erase the one-shot body before awaiting native I/O. Codes never enter chat, URLs or persisted state.
      req.body = undefined;
      return res.json(
        await service.submit(res.locals.authSession, z.uuid().parse(req.params.id), code),
      );
    }),
  );
  router.post(
    '/:id/cancel',
    route(async (req, res, service) => {
      z.strictObject({}).parse(req.body);
      return res.json(await service.cancel(res.locals.authSession, z.uuid().parse(req.params.id)));
    }),
  );
  const parserFailure: express.ErrorRequestHandler = (cause, _req, res, _next) => {
    res
      .status(cause?.type === 'entity.too.large' ? 413 : 400)
      .json({ error: 'Use a complete Claude sign-in code in the private form.' });
  };
  router.use(parserFailure);
  return router;
}
