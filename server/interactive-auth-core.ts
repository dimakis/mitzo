import { SignJWT, jwtVerify } from 'jose';
import { createHash, randomUUID } from 'node:crypto';
import type { Request } from 'express';

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

export interface AuthSession {
  id: string;
  expiresAt: number;
}

type AuthInvalidationReason = 'expired' | 'revoked';
type AuthInvalidationListener = (reason: AuthInvalidationReason) => void;

export interface InteractiveAuthConfig {
  passphrase: string;
  secret: string;
  maxAgeHours: number;
  cookieName: string;
  /** Explicit isolated realm: rejects ordinary/legacy JWTs and the normal cookie. */
  realm?: { issuer: string; audience: string };
}

/** No ambient config, logger, filesystem, internal-token or custodian imports.
 * Constructing this factory creates only process-local session state. Timers
 * start only when a session is registered or revoked. */
export function createInteractiveAuth(input: InteractiveAuthConfig) {
  const config = { ...input, realm: input.realm ? { ...input.realm } : undefined };
  const error = validateConfig(config.passphrase, config.secret, String(config.maxAgeHours));
  if (error) throw new Error(error);
  if (!/^[A-Za-z0-9_-]+$/.test(config.cookieName)) throw new Error('Invalid cookie namespace');
  if (
    config.realm &&
    (!config.realm.issuer.trim() ||
      !config.realm.audience.trim() ||
      config.cookieName === 'cc_auth')
  )
    throw new Error('An isolated issuer, audience and cookie namespace are required');
  const PASSPHRASE = config.passphrase;
  const SECRET = new TextEncoder().encode(config.secret);
  const MAX_AGE_HOURS = config.maxAgeHours;
  const COOKIE_NAME = config.cookieName;
  const revokedSessions = new Map<string, number>();
  const activeSessions = new Map<string, Set<AuthInvalidationListener>>();
  const MAX_TIMER_DELAY_MS = 2_147_000_000;

  async function login(passphrase: string): Promise<string | null> {
    if (passphrase !== PASSPHRASE) return null;

    const jwt = new SignJWT({ sub: 'user' });
    if (config.realm) jwt.setIssuer(config.realm.issuer).setAudience(config.realm.audience);
    return jwt
      .setProtectedHeader({ alg: 'HS256' })
      .setJti(randomUUID())
      .setExpirationTime(`${MAX_AGE_HOURS}h`)
      .setIssuedAt()
      .sign(SECRET);
  }

  /** Used only by narrowly scoped, recent-reauthorization flows. */
  function verifyPassphrase(passphrase: string): boolean {
    return passphrase === PASSPHRASE;
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

  async function authenticateToken(token: string): Promise<AuthSession | null> {
    try {
      const { payload } = await jwtVerify(
        token,
        SECRET,
        config.realm
          ? { issuer: config.realm.issuer, audience: config.realm.audience, algorithms: ['HS256'] }
          : undefined,
      );
      if (
        payload.sub !== 'user' ||
        (config.realm !== undefined &&
          (typeof payload.jti !== 'string' || payload.jti.length === 0)) ||
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

  async function verifyToken(token: string): Promise<boolean> {
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

  async function authenticateRequest(
    req: Pick<Request, 'headers' | 'path' | 'query' | 'cookies'>,
  ): Promise<AuthSession | null> {
    const token = selectRequestToken(req as Request);
    return token ? authenticateToken(token) : null;
  }
  async function verifyWsAuth(cookie: string | undefined): Promise<boolean> {
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
  async function authenticateWs(
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
  function registerAuthSession(
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

  function revokeAuthSession(session: AuthSession | undefined): void {
    if (!session) return;
    revokedSessions.set(session.id, session.expiresAt);
    scheduleAt(session.expiresAt, () => {
      if (revokedSessions.get(session.id) === session.expiresAt) revokedSessions.delete(session.id);
    });
    const listeners = activeSessions.get(session.id);
    activeSessions.delete(session.id);
    for (const listener of listeners ?? []) listener('revoked');
  }

  /** Logout invalidation must outlive an individual proxied HTTP request. */
  function revokeOperatorSessions(
    sessions: readonly (AuthSession | null)[],
    notify?: (jti: string) => void,
  ) {
    for (const session of sessions) {
      if (!session) continue;
      revokeAuthSession(session);
      notify?.(session.id);
    }
  }

  return {
    login,
    verifyPassphrase,
    authenticateToken,
    verifyToken,
    authenticateRequest,
    verifyWsAuth,
    authenticateWs,
    registerAuthSession,
    revokeAuthSession,
    revokeOperatorSessions,
    isSessionRevoked,
    selectRequestToken,
    cookieName: COOKIE_NAME,
    maxAgeHours: MAX_AGE_HOURS,
  };
}
