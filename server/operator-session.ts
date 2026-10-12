import type { Request, Response, NextFunction } from 'express';
import { custodianRequestAuthority } from './symposium-custodian-authority.js';
import {
  createInteractiveAuth,
  parseCookieMaxAgeHours,
  validateConfig,
} from './interactive-auth-core.js';
const rawMaxAgeHours = process.env.COOKIE_MAX_AGE_HOURS ?? '24';
const parsedMaxAgeHours = parseCookieMaxAgeHours(rawMaxAgeHours);
const MAX_AGE_HOURS = parsedMaxAgeHours!;
const COOKIE_NAME = 'cc_auth';
type InteractiveAuth = ReturnType<typeof createInteractiveAuth>;
let active: InteractiveAuth | undefined;
/** Importing native semantic routes never reads credentials or creates auth state. */
function interactive(): InteractiveAuth {
  if (active) return active;
  const configError = validateConfig(
    process.env.AUTH_PASSPHRASE,
    process.env.AUTH_SECRET,
    rawMaxAgeHours,
    parsedMaxAgeHours,
  );
  if (configError) throw Error(`Invalid interactive authentication configuration: ${configError}`);
  active = createInteractiveAuth({
    passphrase: process.env.AUTH_PASSPHRASE!,
    secret: process.env.AUTH_SECRET!,
    maxAgeHours: MAX_AGE_HOURS,
    cookieName: COOKIE_NAME,
  });
  return active;
}
export const initializeOperatorSession = () => {
  interactive();
};
export const login = (...args: Parameters<InteractiveAuth['login']>) =>
  interactive().login(...args);
export const verifyPassphrase = (...args: Parameters<InteractiveAuth['verifyPassphrase']>) =>
  interactive().verifyPassphrase(...args);
export const authenticateToken = (...args: Parameters<InteractiveAuth['authenticateToken']>) =>
  interactive().authenticateToken(...args);
export const verifyToken = (...args: Parameters<InteractiveAuth['verifyToken']>) =>
  interactive().verifyToken(...args);
export const verifyWsAuth = (...args: Parameters<InteractiveAuth['verifyWsAuth']>) =>
  interactive().verifyWsAuth(...args);
export const authenticateWs = (...args: Parameters<InteractiveAuth['authenticateWs']>) =>
  interactive().authenticateWs(...args);
export const registerAuthSession = (...args: Parameters<InteractiveAuth['registerAuthSession']>) =>
  interactive().registerAuthSession(...args);
export const revokeAuthSession = (...args: Parameters<InteractiveAuth['revokeAuthSession']>) =>
  interactive().revokeAuthSession(...args);
export const revokeOperatorSessions = (
  ...args: Parameters<InteractiveAuth['revokeOperatorSessions']>
) => interactive().revokeOperatorSessions(...args);
export const isSessionRevoked = (...args: Parameters<InteractiveAuth['isSessionRevoked']>) =>
  interactive().isSessionRevoked(...args);
export const selectRequestToken = (...args: Parameters<InteractiveAuth['selectRequestToken']>) =>
  interactive().selectRequestToken(...args);
export type { AuthSession } from './interactive-auth-core.js';
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

  const session = await interactive().authenticateRequest(req);
  if (!session) {
    res.status(403).json({ error: 'Interactive operator authentication is required' });
    return;
  }
  res.locals.authSession = session;
  next();
}

export { COOKIE_NAME, MAX_AGE_HOURS };
