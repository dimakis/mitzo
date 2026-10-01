import { custodianRequestAuthority } from './symposium-custodian-authority.js';
import type { Request, Response, NextFunction } from 'express';
import { isValidInternalToken, isValidSignalCallbackToken } from './internal-token.js';

import {
  createInteractiveAuth,
  parseCookieMaxAgeHours,
  validateConfig,
} from './interactive-auth-core.js';
export { parseCookieMaxAgeHours, validateConfig } from './interactive-auth-core.js';

import { createLogger } from './logger.js';

const log = createLogger('auth');

const rawMaxAgeHours = process.env.COOKIE_MAX_AGE_HOURS ?? '24';
const parsedMaxAgeHours = parseCookieMaxAgeHours(rawMaxAgeHours);
const configError = validateConfig(
  process.env.AUTH_PASSPHRASE,
  process.env.AUTH_SECRET,
  rawMaxAgeHours,
  parsedMaxAgeHours,
);
if (configError) {
  log.error(`FATAL: ${configError}`);
  process.exit(1);
}

const PASSPHRASE = process.env.AUTH_PASSPHRASE!;
const MAX_AGE_HOURS = parsedMaxAgeHours!;
const COOKIE_NAME = 'cc_auth';

const interactive = createInteractiveAuth({
  passphrase: PASSPHRASE,
  secret: process.env.AUTH_SECRET!,
  maxAgeHours: MAX_AGE_HOURS,
  cookieName: COOKIE_NAME,
});
export const {
  login,
  verifyPassphrase,
  authenticateToken,
  verifyToken,
  verifyWsAuth,
  authenticateWs,
  registerAuthSession,
  revokeAuthSession,
  revokeOperatorSessions,
} = interactive;
const { isSessionRevoked } = interactive;
export type { AuthSession } from './interactive-auth-core.js';

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    const retained = custodianRequestAuthority(req);
    if (retained) {
      if (isSessionRevoked(retained))
        return res.status(403).json({ error: 'Operator session revoked' });
      res.locals.authSession = { id: retained.id, expiresAt: retained.expiresAt };
      return next();
    }
  } catch {
    return res.status(403).json({ error: 'Custodian controller authority unavailable' });
  }

  if (req.path === '/auth/login') return next();

  // Allow internal-token auth for programmatic access (agents, CLI).
  // All /api/* routes are accessible with the internal token — this is
  // intentional to support task board, template, and loop endpoints.
  if (isValidInternalToken(req.headers['x-internal-token'])) {
    return next();
  }

  // Centaur stores only this task-scoped callback URL. The HMAC cannot be used
  // to access another task or any other authenticated API route.
  const signalMatch = req.method === 'POST' ? req.path.match(/^\/tasks\/([^/]+)\/signal$/) : null;
  const signalToken = typeof req.query.token === 'string' ? req.query.token : undefined;
  if (signalMatch && isValidSignalCallbackToken(signalMatch[1], signalToken)) {
    return next();
  }

  // EventSource cannot attach Authorization headers. Query authentication is
  // deliberately limited to the two read-only SSE endpoints.
  const token = interactive.selectRequestToken(req);
  if (!token) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const session = await authenticateToken(token);
  if (!session) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }
  res.locals.authSession = session;
  next();
}

/** Destructive operator actions cannot use the internal agent/hooks token.
 * This reuses the ordinary interactive JWT/cookie session mechanism even when
 * the broader API middleware admitted an internal caller. */
export async function operatorAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    const retained = custodianRequestAuthority(req);
    if (retained) {
      if (isSessionRevoked(retained))
        return res.status(403).json({ error: 'Operator session revoked' });
      res.locals.authSession = { id: retained.id, expiresAt: retained.expiresAt };
      return next();
    }
  } catch {
    return res.status(403).json({ error: 'Custodian controller authority unavailable' });
  }

  const session = await interactive.authenticateRequest(req);
  if (!session) {
    res.status(403).json({ error: 'Interactive operator authentication is required' });
    return;
  }
  res.locals.authSession = session;
  next();
}

export { COOKIE_NAME, MAX_AGE_HOURS };
