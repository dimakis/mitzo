import { SignJWT, jwtVerify } from 'jose';
import type { Request, Response, NextFunction } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { isValidInternalToken } from './internal-token.js';

const INSECURE_PASSPHRASES = ['change-me', 'change-me-to-something-secure'];
const INSECURE_SECRETS = [
  'dev-secret-replace-in-production-min32chars!',
  'replace-with-random-secret-key-min-32-chars',
];
const MAX_COOKIE_AGE_HOURS = 8_760;

export function parseCookieMaxAgeHours(value = '24'): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= MAX_COOKIE_AGE_HOURS ? parsed : null;
}

export function validateConfig(
  passphrase?: string,
  secret?: string,
  maxAgeHours = '24',
  parsedMaxAge: number | null = parseCookieMaxAgeHours(maxAgeHours),
): string | null {
  if (!passphrase || INSECURE_PASSPHRASES.includes(passphrase)) {
    return 'AUTH_PASSPHRASE must be set to a secure value in .env';
  }
  if (
    !secret ||
    INSECURE_SECRETS.includes(secret) ||
    new TextEncoder().encode(secret).length < 32
  ) {
    return 'AUTH_SECRET must be set to a secure value (min 32 chars) in .env';
  }
  if (parsedMaxAge === null) {
    return `COOKIE_MAX_AGE_HOURS must be a positive whole number no greater than ${MAX_COOKIE_AGE_HOURS}`;
  }
  return null;
}

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
const SECRET = new TextEncoder().encode(process.env.AUTH_SECRET!);
const MAX_AGE_HOURS = parsedMaxAgeHours!;
const COOKIE_NAME = 'cc_auth';

export interface AuthSession {
  id: string;
  expiresAt: number;
}

type AuthInvalidationReason = 'expired' | 'revoked';
type AuthInvalidationListener = (reason: AuthInvalidationReason) => void;

const revokedSessions = new Map<string, number>();
const activeSessions = new Map<string, Set<AuthInvalidationListener>>();
const MAX_TIMER_DELAY_MS = 2_147_000_000;

export async function login(passphrase: string): Promise<string | null> {
  if (passphrase !== PASSPHRASE) return null;

  return new SignJWT({ sub: 'user' })
    .setProtectedHeader({ alg: 'HS256' })
    .setJti(randomUUID())
    .setExpirationTime(`${MAX_AGE_HOURS}h`)
    .setIssuedAt()
    .sign(SECRET);
}

function isSessionRevoked(session: AuthSession): boolean {
  const revokedUntil = revokedSessions.get(session.id);
  if (revokedUntil === undefined) return false;
  if (revokedUntil <= Date.now()) {
    revokedSessions.delete(session.id);
    return false;
  }
  return true;
}

export async function authenticateToken(token: string): Promise<AuthSession | null> {
  try {
    const { payload } = await jwtVerify(token, SECRET);
    if (
      payload.sub !== 'user' ||
      typeof payload.exp !== 'number' ||
      (typeof payload.jti !== 'undefined' && typeof payload.jti !== 'string')
    ) {
      return null;
    }
    const id = payload.jti ?? createHash('sha256').update(token).digest('base64url');
    const session = { id, expiresAt: payload.exp * 1000 };
    if (isSessionRevoked(session)) return null;
    return session;
  } catch {
    return null;
  }
}

export async function verifyToken(token: string): Promise<boolean> {
  return (await authenticateToken(token)) !== null;
}

function extractBearerToken(req: Request): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  return undefined;
}

function extractSseQueryToken(req: Request): string | undefined {
  if (req.path !== '/events' && req.path !== '/chat/events') return undefined;
  return typeof req.query.token === 'string' ? req.query.token : undefined;
}

function selectRequestToken(req: Request): string | undefined {
  // Explicit credentials are authoritative. Never let a stale ambient cookie
  // override them or rescue an invalid credential supplied by the caller.
  if (req.headers.authorization !== undefined) return extractBearerToken(req);
  const isSseRoute = req.path === '/events' || req.path === '/chat/events';
  if (isSseRoute && Object.prototype.hasOwnProperty.call(req.query, 'token')) {
    return extractSseQueryToken(req);
  }
  return req.cookies?.[COOKIE_NAME];
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (req.path === '/auth/login') return next();

  // Allow internal-token auth for programmatic access (agents, CLI).
  // All /api/* routes are accessible with the internal token — this is
  // intentional to support task board, template, and loop endpoints.
  if (isValidInternalToken(req.headers['x-internal-token'])) {
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

function extractCookieToken(cookie: string | undefined): string | undefined {
  if (!cookie) return undefined;
  const cookies = cookie.split(';').reduce(
    (acc, value) => {
      const [key, ...parts] = value.trim().split('=');
      acc[key] = parts.join('=');
      return acc;
    },
    {} as Record<string, string>,
  );
  return cookies[COOKIE_NAME];
}

/** Query credentials are explicit for native clients and take precedence over cookies. */
export async function authenticateWs(
  cookie: string | undefined,
  queryToken: string | null,
): Promise<AuthSession | null> {
  const token = queryToken !== null ? queryToken : extractCookieToken(cookie);
  return token ? authenticateToken(token) : null;
}

function scheduleAt(expiresAt: number, callback: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      callback();
      return;
    }
    timer = setTimeout(schedule, Math.min(remaining, MAX_TIMER_DELAY_MS));
    timer.unref?.();
  };
  schedule();
  return () => {
    if (timer) clearTimeout(timer);
  };
}

/** Register an active transport for immediate expiry and logout enforcement. */
export function registerAuthSession(
  session: AuthSession,
  listener: AuthInvalidationListener,
): () => void {
  if (isSessionRevoked(session)) {
    listener('revoked');
    return () => undefined;
  }
  if (session.expiresAt <= Date.now()) {
    listener('expired');
    return () => undefined;
  }
  const listeners = activeSessions.get(session.id) ?? new Set<AuthInvalidationListener>();
  listeners.add(listener);
  activeSessions.set(session.id, listeners);
  const cancelExpiry = scheduleAt(session.expiresAt, () => listener('expired'));
  return () => {
    cancelExpiry();
    const current = activeSessions.get(session.id);
    current?.delete(listener);
    if (current?.size === 0) activeSessions.delete(session.id);
  };
}

export function revokeAuthSession(session: AuthSession | undefined): void {
  if (!session) return;
  revokedSessions.set(session.id, session.expiresAt);
  scheduleAt(session.expiresAt, () => {
    if (revokedSessions.get(session.id) === session.expiresAt) revokedSessions.delete(session.id);
  });
  const listeners = activeSessions.get(session.id);
  activeSessions.delete(session.id);
  for (const listener of listeners ?? []) listener('revoked');
}

export { COOKIE_NAME, MAX_AGE_HOURS };
