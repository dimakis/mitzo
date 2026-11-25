import type { NextFunction, Request, Response } from 'express';
import type { AuthSession } from './interactive-auth-core.js';

/** Shared browser request guards; provider/connection services are not HTTP authority. */
export function recentAuthorizationSession(res: Response): AuthSession | undefined {
  const value = res.locals.authSession as AuthSession | undefined;
  if (!value || value.expiresAt <= Date.now()) {
    res.status(401).json({ error: 'Browser authentication required' });
    return;
  }
  return value;
}

export function requireSameOriginJson(req: Request, res: Response, next: NextFunction) {
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
