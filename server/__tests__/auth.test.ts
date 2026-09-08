import { describe, it, expect, vi } from 'vitest';
import { validateConfig, authMiddleware, registerAuthSession, revokeAuthSession } from '../auth.js';
import { INTERNAL_TOKEN } from '../internal-token.js';
import { SignJWT } from 'jose';

describe('validateConfig', () => {
  it('rejects missing passphrase', () => {
    expect(validateConfig(undefined, 'a-valid-secret-that-is-long-enough-32chars!!')).toMatch(
      /AUTH_PASSPHRASE/,
    );
  });

  it('rejects empty passphrase', () => {
    expect(validateConfig('', 'a-valid-secret-that-is-long-enough-32chars!!')).toMatch(
      /AUTH_PASSPHRASE/,
    );
  });

  it('rejects insecure default passphrase', () => {
    expect(validateConfig('change-me', 'a-valid-secret-that-is-long-enough-32chars!!')).toMatch(
      /AUTH_PASSPHRASE/,
    );
    expect(
      validateConfig(
        'change-me-to-something-secure',
        'a-valid-secret-that-is-long-enough-32chars!!',
      ),
    ).toMatch(/AUTH_PASSPHRASE/);
  });

  it('rejects missing secret', () => {
    expect(validateConfig('good-passphrase', undefined)).toMatch(/AUTH_SECRET/);
  });

  it('rejects insecure default secret', () => {
    expect(
      validateConfig('good-passphrase', 'dev-secret-replace-in-production-min32chars!'),
    ).toMatch(/AUTH_SECRET/);
  });

  it('rejects secrets shorter than 32 characters', () => {
    expect(validateConfig('good-passphrase', 'short-secret', '1')).toMatch(/32/);
  });

  it.each(['0', '-1', 'NaN', '1.5', '', '1e2', '0x10', ' 1', '1 ', '8761', '3000000000'])(
    'rejects invalid cookie TTL %j',
    (ttl) => {
      expect(
        validateConfig('good-passphrase', 'a-valid-secret-that-is-long-enough-32chars!!', ttl),
      ).toMatch(/COOKIE_MAX_AGE_HOURS/);
    },
  );

  it('accepts valid config', () => {
    expect(
      validateConfig('my-secure-passphrase', 'a-valid-secret-that-is-long-enough-32chars!!'),
    ).toBeNull();
    expect(
      validateConfig(
        'my-secure-passphrase',
        'a-valid-secret-that-is-long-enough-32chars!!',
        '8760',
      ),
    ).toBeNull();
  });
});

describe('login and verifyToken', () => {
  it('returns null for wrong passphrase', async () => {
    const { login } = await import('../auth.js');
    const token = await login('wrong-passphrase');
    expect(token).toBeNull();
  });

  it('returns a valid JWT for correct passphrase', async () => {
    const { login, verifyToken } = await import('../auth.js');
    const token = await login(process.env.AUTH_PASSPHRASE!);
    expect(token).toBeTruthy();
    expect(typeof token).toBe('string');
    expect(await verifyToken(token!)).toBe(true);
  });

  it('rejects tampered tokens', async () => {
    const { verifyToken } = await import('../auth.js');
    expect(await verifyToken('not-a-real-jwt')).toBe(false);
  });

  it('keeps pre-upgrade signed tokens valid until their existing expiry', async () => {
    const legacyToken = await new SignJWT({ sub: 'user' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .setIssuedAt()
      .sign(new TextEncoder().encode(process.env.AUTH_SECRET!));
    const { authenticateToken } = await import('../auth.js');

    expect(await authenticateToken(legacyToken)).toEqual(
      expect.objectContaining({ id: expect.any(String), expiresAt: expect.any(Number) }),
    );
  });
});

describe('verifyWsAuth', () => {
  it('rejects undefined cookie', async () => {
    const { verifyWsAuth } = await import('../auth.js');
    expect(await verifyWsAuth(undefined)).toBe(false);
  });

  it('rejects cookie without auth token', async () => {
    const { verifyWsAuth } = await import('../auth.js');
    expect(await verifyWsAuth('other_cookie=value')).toBe(false);
  });

  it('accepts cookie with valid auth token', async () => {
    const { login, verifyWsAuth } = await import('../auth.js');
    const token = await login(process.env.AUTH_PASSPHRASE!);
    expect(await verifyWsAuth(`cc_auth=${token}`)).toBe(true);
  });

  it('handles multiple cookies', async () => {
    const { login, verifyWsAuth } = await import('../auth.js');
    const token = await login(process.env.AUTH_PASSPHRASE!);
    expect(await verifyWsAuth(`other=foo; cc_auth=${token}; bar=baz`)).toBe(true);
  });

  it('uses an explicit fresh query token instead of a stale cookie', async () => {
    const { login, authenticateWs } = await import('../auth.js');
    const token = await login(process.env.AUTH_PASSPHRASE!);

    expect(await authenticateWs('cc_auth=stale', token)).toEqual(
      expect.objectContaining({ id: expect.any(String) }),
    );
  });

  it('does not fall back to a valid cookie when an explicit query token is invalid', async () => {
    const { login, authenticateWs } = await import('../auth.js');
    const token = await login(process.env.AUTH_PASSPHRASE!);

    expect(await authenticateWs(`cc_auth=${token}`, 'stale')).toBeNull();
  });
});

describe('authMiddleware — internal token', () => {
  function mockReq(
    headers: Record<string, string> = {},
    path = '/tasks',
    query: Record<string, string> = {},
  ) {
    return { headers, path, query, cookies: {} } as unknown as Parameters<typeof authMiddleware>[0];
  }

  type MockResponse = Parameters<typeof authMiddleware>[1] & { statusCode: number };

  function mockRes(): MockResponse {
    const res = { statusCode: 0, locals: {} } as unknown as MockResponse;
    res.status = (code: number) => {
      res.statusCode = code;
      return res;
    };
    res.json = vi.fn().mockReturnValue(res) as unknown as MockResponse['json'];
    return res;
  }

  it('bypasses JWT auth with valid internal token', () => {
    const req = mockReq({ 'x-internal-token': INTERNAL_TOKEN });
    const res = mockRes();
    const next = vi.fn();

    authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('rejects invalid internal token (wrong length)', () => {
    const req = mockReq({ 'x-internal-token': 'wrong-token' });
    const res = mockRes();
    const next = vi.fn();

    authMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('rejects invalid internal token (same length, wrong value)', () => {
    // INTERNAL_TOKEN is 64 hex chars — use a same-length string to exercise timingSafeEqual
    const fakeToken = '0'.repeat(INTERNAL_TOKEN.length);
    const req = mockReq({ 'x-internal-token': fakeToken });
    const res = mockRes();
    const next = vi.fn();

    authMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('rejects request with no auth at all', () => {
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    authMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('allows /auth/login without any auth', () => {
    const req = mockReq({}, '/auth/login');
    const res = mockRes();
    const next = vi.fn();

    authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('falls through to JWT auth when no internal token', async () => {
    const { login } = await import('../auth.js');
    const jwt = await login(process.env.AUTH_PASSPHRASE!);
    const req = mockReq({ authorization: `Bearer ${jwt}` });
    const res = mockRes();
    const next = vi.fn();

    authMiddleware(req, res, next);

    // verifyToken is async — wait for it to resolve
    await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
  });

  it('prefers an explicit fresh bearer over a stale cookie', async () => {
    const { login } = await import('../auth.js');
    const jwt = await login(process.env.AUTH_PASSPHRASE!);
    const req = mockReq({ authorization: `Bearer ${jwt}` });
    req.cookies = { cc_auth: 'stale-cookie' };
    const res = mockRes();
    const next = vi.fn();

    authMiddleware(req, res, next);

    await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
  });

  it('does not fall back to a cookie when an explicit bearer is invalid', async () => {
    const { login } = await import('../auth.js');
    const jwt = await login(process.env.AUTH_PASSPHRASE!);
    const req = mockReq({ authorization: 'Bearer stale-bearer' });
    req.cookies = { cc_auth: jwt! };
    const res = mockRes();
    const next = vi.fn();

    authMiddleware(req, res, next);

    await vi.waitFor(() => expect(res.statusCode).toBe(401));
    expect(next).not.toHaveBeenCalled();
  });

  it.each(['/events', '/chat/events'])(
    'accepts a valid query token for SSE route %s',
    async (path) => {
      const { login } = await import('../auth.js');
      const jwt = await login(process.env.AUTH_PASSPHRASE!);
      const req = mockReq({}, path, { token: jwt! });
      const res = mockRes();
      const next = vi.fn();

      authMiddleware(req, res, next);

      await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
    },
  );

  it('prefers an explicit SSE query token over a stale cookie', async () => {
    const { login } = await import('../auth.js');
    const jwt = await login(process.env.AUTH_PASSPHRASE!);
    const req = mockReq({}, '/chat/events', { token: jwt! });
    req.cookies = { cc_auth: 'stale-cookie' };
    const res = mockRes();
    const next = vi.fn();

    authMiddleware(req, res, next);

    await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
  });

  it('does not accept query tokens on ordinary API routes', async () => {
    const { login } = await import('../auth.js');
    const jwt = await login(process.env.AUTH_PASSPHRASE!);
    const req = mockReq({}, '/sessions', { token: jwt! });
    const res = mockRes();
    const next = vi.fn();

    authMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});

describe('active authentication lifetime', () => {
  it('closes registered transports when their token is revoked', () => {
    const close = vi.fn();
    const session = { id: 'session-to-revoke', expiresAt: Date.now() + 60_000 };
    const unregister = registerAuthSession(session, close);

    revokeAuthSession(session);

    expect(close).toHaveBeenCalledWith('revoked');
    unregister();
  });

  it('closes registered transports when their token expires', async () => {
    vi.useFakeTimers();
    const close = vi.fn();
    registerAuthSession({ id: 'session-to-expire', expiresAt: Date.now() + 1_000 }, close);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(close).toHaveBeenCalledWith('expired');
    vi.useRealTimers();
  });
});
