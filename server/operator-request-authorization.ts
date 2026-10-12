import express from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { custodianRequestAuthority } from './symposium-custodian-authority.js';
import { verifyPassphrase, type AuthSession } from './operator-session.js';
import { ConnectionReauthorizeBody } from './api-schemas.js';
const TTL = 5 * 60_000,
  MAX_CAPABILITIES = 256;
const capabilities = new Map<string, { csrf: string; expiresAt: number }>();
const reauthorizationApps = new WeakMap<object, string>();
const appReauthorizationLimiter = rateLimit({
  keyGenerator: (req) => {
    let appId = reauthorizationApps.get(req.app);
    if (!appId) {
      appId = randomUUID();
      reauthorizationApps.set(req.app, appId);
    }
    return `${appId}:${ipKeyGenerator(req.ip ?? 'unknown')}`;
  },
  windowMs: 60_000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many reauthorization attempts, try again in a minute' },
});
/** Shared app-auth capability issuer, also available without legacy connections. */
export function recentAppReauthorizationHandlers(): express.RequestHandler[] {
  return [
    appReauthorizationLimiter,
    requireSameOriginJson,
    express.json({ limit: '2kb' }),
    (req, res) => {
      res.set('Cache-Control', 'no-store');
      const auth = recentAuthorizationSession(res),
        parsed = ConnectionReauthorizeBody.safeParse(req.body);
      if (!auth || !parsed.success || !verifyPassphrase(parsed.data.passphrase))
        return res.status(403).json({ error: 'Reauthorization failed' });
      const now = Date.now();
      for (const [id, item] of capabilities) if (item.expiresAt <= now) capabilities.delete(id);
      while (capabilities.size >= MAX_CAPABILITIES)
        capabilities.delete(capabilities.keys().next().value!);
      const expiresAt = Math.min(auth.expiresAt, now + TTL),
        csrf = randomUUID() + randomUUID();
      capabilities.set(auth.id, { csrf, expiresAt });
      return res.json({ csrf, expiresAt });
    },
  ];
}

export function recentAuthorizationSession(res: express.Response): AuthSession | undefined {
  const value = res.locals.authSession as AuthSession | undefined;
  if (!value || value.expiresAt <= Date.now()) {
    res.status(401).json({ error: 'Browser authentication required' });
    return;
  }
  return value;
}
/** Export only the validity bound of a capability verified in this app process. */
export function recentAuthorizationExpiry(res: express.Response, csrf: string): number | undefined {
  const auth = res.locals.authSession as AuthSession | undefined;
  if (!auth || auth.expiresAt <= Date.now()) return undefined;
  const capability = capabilities.get(auth.id);
  if (!capability || capability.csrf !== csrf || capability.expiresAt <= Date.now())
    return undefined;
  return Math.min(capability.expiresAt, auth.expiresAt);
}
export function requireRecentConnectionAuthorization(res: express.Response, csrf: string) {
  try {
    const retained = custodianRequestAuthority(res.req);
    if (retained) {
      if (retained.recentUntil && retained.recentUntil > Date.now()) return true;
      res.status(403).json({ error: 'Recent reauthorization required' });
      return false;
    }
  } catch {
    res.status(403).json({ error: 'Custodian authorization unavailable' });
    return false;
  }
  const value = recentAuthorizationSession(res);
  if (!value) return false;
  const capability = capabilities.get(value.id);
  if (!capability || capability.expiresAt <= Date.now() || capability.csrf !== csrf) {
    capabilities.delete(value.id);
    res.status(403).json({ error: 'Recent reauthorization required' });
    return false;
  }
  return true;
}
export function requireSameOriginJson(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  const origin = req.header('origin');
  const allowed = new Set(
    (process.env.CORS_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
  );
  const host = req.get('host');
  if (host) allowed.add(`${req.protocol}://${host}`);
  if (origin && !allowed.has(origin)) return res.status(403).json({ error: 'Untrusted origin' });
  if (!req.is('application/json'))
    return res.status(415).json({ error: 'Content-Type must be application/json' });
  next();
}
