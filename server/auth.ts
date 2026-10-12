import { custodianRequestAuthority } from './symposium-custodian-authority.js';
import type { Request, Response, NextFunction } from 'express';
import { isValidInternalToken, isValidSignalCallbackToken } from './internal-token.js';
import { isSessionRevoked, authenticateToken, selectRequestToken } from './operator-session.js';
export { parseCookieMaxAgeHours, validateConfig } from './interactive-auth-core.js';
export {
  login,
  verifyPassphrase,
  authenticateToken,
  verifyToken,
  verifyWsAuth,
  authenticateWs,
  registerAuthSession,
  revokeAuthSession,
  revokeOperatorSessions,
  operatorAuthMiddleware,
  initializeOperatorSession,
  COOKIE_NAME,
  MAX_AGE_HOURS,
} from './operator-session.js';
export type { AuthSession } from './operator-session.js';

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
  const token = selectRequestToken(req);
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
