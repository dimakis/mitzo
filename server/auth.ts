import { SignJWT, jwtVerify } from 'jose';
import type { Request, Response, NextFunction } from 'express';
import { isValidInternalToken } from './internal-token.js';

const INSECURE_PASSPHRASES = ['change-me', 'change-me-to-something-secure'];
const INSECURE_SECRETS = [
  'dev-secret-replace-in-production-min32chars!',
  'replace-with-random-secret-key-min-32-chars',
];

export function validateConfig(passphrase?: string, secret?: string): string | null {
  if (!passphrase || INSECURE_PASSPHRASES.includes(passphrase)) {
    return 'AUTH_PASSPHRASE must be set to a secure value in .env';
  }
  if (!secret || INSECURE_SECRETS.includes(secret)) {
    return 'AUTH_SECRET must be set to a secure value (min 32 chars) in .env';
  }
  return null;
}

import { createLogger } from './logger.js';

const log = createLogger('auth');

const configError = validateConfig(process.env.AUTH_PASSPHRASE, process.env.AUTH_SECRET);
if (configError) {
  log.error(`FATAL: ${configError}`);
  process.exit(1);
}

const PASSPHRASE = process.env.AUTH_PASSPHRASE!;
const SECRET = new TextEncoder().encode(process.env.AUTH_SECRET!);
const MAX_AGE_HOURS = parseInt(process.env.COOKIE_MAX_AGE_HOURS || '24', 10);
const COOKIE_NAME = 'cc_auth';

export async function login(passphrase: string): Promise<string | null> {
  if (passphrase !== PASSPHRASE) return null;

  return new SignJWT({ sub: 'user' })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(`${MAX_AGE_HOURS}h`)
    .setIssuedAt()
    .sign(SECRET);
}

export async function verifyToken(token: string): Promise<boolean> {
  try {
    await jwtVerify(token, SECRET);
    return true;
  } catch {
    return false;
  }
}

function extractBearerToken(req: Request): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return undefined;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (req.path === '/auth/login') return next();

  // Allow internal-token auth for programmatic access (agents, CLI).
  // All /api/* routes are accessible with the internal token — this is
  // intentional to support task board, template, and loop endpoints.
  if (isValidInternalToken(req.headers['x-internal-token'] as string | undefined)) {
    return next();
  }

  const token = req.cookies?.[COOKIE_NAME] || extractBearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  verifyToken(token).then((valid) => {
    if (!valid) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }
    next();
  });
}

export async function verifyWsAuth(cookie: string | undefined): Promise<boolean> {
  if (!cookie) return false;

  const cookies = cookie.split(';').reduce(
    (acc, c) => {
      const [key, ...val] = c.trim().split('=');
      acc[key] = val.join('=');
      return acc;
    },
    {} as Record<string, string>,
  );

  const token = cookies[COOKIE_NAME];
  return token ? verifyToken(token) : false;
}

export { COOKIE_NAME, MAX_AGE_HOURS };
