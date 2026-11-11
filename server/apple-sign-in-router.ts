import express, { type RequestHandler, type ErrorRequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppleSignInError, APPLE_TRANSACTION_TTL_MS, type AppleSignIn } from './apple-sign-in.js';
import type { AppleSignInConfig } from './apple-sign-in-provider.js';

const transactionCookie = '__Host-mitzo-apple';
const binding = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const startBody = z
  .object({
    client: z.enum(['web', 'native']),
    enrollPassphrase: z.string().min(1).max(1024).optional(),
  })
  .strict();
const finishBody = z
  .object({ state: binding, verifier: binding, code: z.string().min(1).max(4096) })
  .strict();
const callbackQuery = z
  .object({
    state: binding,
    code: z.string().min(1).max(4096).optional(),
    error: z.string().min(1).max(100).optional(),
  })
  .strict();

export function createAppleSignInRouter(options: {
  config: AppleSignInConfig | null;
  service: AppleSignIn | null;
  cookieName: string;
  maxAgeHours: number;
  warn: (message: string, fields: Record<string, unknown>) => void;
}) {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    next();
  });
  const guarded =
    (stage: string, handler: RequestHandler): RequestHandler =>
    (req, res, next) => {
      void Promise.resolve()
        .then(() => handler(req, res, next))
        .catch((cause: unknown) => {
          const code = cause instanceof AppleSignInError ? cause.code : 'service_unavailable';
          const requestId = randomUUID();
          options.warn('Apple sign-in did not complete', {
            stage,
            code,
            requestId,
            causeType: cause instanceof Error ? cause.name : 'UnknownError',
          });
          if (stage === 'callback') {
            res.clearCookie(transactionCookie, {
              secure: true,
              httpOnly: true,
              sameSite: 'lax',
              path: '/',
            });
            res.redirect(
              303,
              `/login?apple=${code === 'cancelled' ? 'cancelled' : 'error'}&reason=${encodeURIComponent(code)}`,
            );
          } else {
            const status = [
              'owner_storage_unavailable',
              'service_unavailable',
              'capacity_exceeded',
              'identity_verification_failed',
            ].includes(code)
              ? 503
              : 403;
            res.status(status).json({
              error: 'Apple sign-in did not complete. Try again or use your passphrase.',
              code,
              requestId,
            });
          }
        });
    };
  router.get(
    '/status',
    guarded('status', (_req, res) => {
      res.json(options.service?.status() ?? { enabled: false });
    }),
  );
  const { service, config } = options;
  if (!service || !config) {
    router.use((_req, res) => {
      res.status(404).json({ error: 'Apple sign-in is not configured' });
    });
    return router;
  }
  // Never derive trusted origins/redirects from Host or forwarded headers.
  const origin = new URL(config.redirectUri).origin;
  const sameOrigin: RequestHandler = (req, res, next) => {
    const allowed = [origin, ...(config.nativeClientId ? ['capacitor://localhost'] : [])];
    if (!allowed.includes(req.header('origin') ?? '')) {
      res.status(403).json({ error: 'Untrusted sign-in origin' });
      return;
    }
    if (!req.is('application/json')) {
      res.status(415).json({ error: 'JSON required' });
      return;
    }
    next();
  };
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many sign-in attempts. Try again in a minute.' },
  });
  router.post(
    '/start',
    limiter,
    sameOrigin,
    express.json({ limit: '2kb' }),
    guarded('start', (req, res) => {
      const parsed = startBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid sign-in request' });
        return;
      }
      const start = service.start(parsed.data.client, parsed.data.enrollPassphrase);
      if (parsed.data.client === 'web') {
        res.cookie(transactionCookie, start.verifier, {
          secure: true,
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
          maxAge: APPLE_TRANSACTION_TTL_MS,
        });
        res.json({ authorizationUrl: start.authorizationUrl });
      } else res.json({ state: start.state, nonce: start.nonce, verifier: start.verifier });
    }),
  );
  router.get(
    '/callback',
    guarded('callback', async (req, res) => {
      const parsed = callbackQuery.safeParse(req.query);
      const verifier = req.cookies?.[transactionCookie];
      if (!parsed.success || !binding.safeParse(verifier).success)
        throw new AppleSignInError('invalid_transaction');
      const token = await service.finish({ client: 'web', ...parsed.data, verifier });
      res.clearCookie(transactionCookie, {
        secure: true,
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
      });
      res.cookie(options.cookieName, token, {
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        path: '/',
        maxAge: options.maxAgeHours * 60 * 60 * 1000,
      });
      res.redirect(303, '/login?apple=success');
    }),
  );
  router.post(
    '/native',
    limiter,
    sameOrigin,
    express.json({ limit: '8kb' }),
    guarded('native', async (req, res) => {
      const parsed = finishBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid native sign-in result' });
        return;
      }
      const token = await service.finish({ client: 'native', ...parsed.data });
      res.json({ ok: true, token });
    }),
  );
  // Express parser errors can carry the raw credential-bearing request body.
  // Contain them here, before the application's generic error/logging boundary.
  const parserFailure: ErrorRequestHandler = (cause: unknown, _req, res, _next) => {
    const type = cause && typeof cause === 'object' && 'type' in cause ? cause.type : undefined;
    const tooLarge = type === 'entity.too.large';
    const invalid =
      type === 'entity.parse.failed' ||
      type === 'encoding.unsupported' ||
      type === 'charset.unsupported';
    const code = tooLarge
      ? 'request_too_large'
      : invalid
        ? 'invalid_request'
        : 'service_unavailable';
    const requestId = randomUUID();
    options.warn('Apple sign-in request could not be read', {
      stage: 'parse',
      code,
      requestId,
      causeType: cause instanceof Error ? cause.name : 'UnknownError',
    });
    res
      .status(tooLarge ? 413 : invalid ? 400 : 503)
      .json({ error: 'Apple sign-in request could not be read. Try again.', code, requestId });
  };
  router.use(parserFailure);
  return router;
}
