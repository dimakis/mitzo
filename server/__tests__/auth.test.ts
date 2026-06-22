import { describe, it, expect, vi } from 'vitest';
import { validateConfig, authMiddleware, verifyToken } from '../auth.js';
import { INTERNAL_TOKEN } from '../internal-token.js';

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

  it('accepts valid config', () => {
    expect(
      validateConfig('my-secure-passphrase', 'a-valid-secret-that-is-long-enough-32chars!!'),
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
});

describe('authMiddleware — internal token', () => {
  function mockReq(headers: Record<string, string> = {}, path = '/tasks') {
    return { headers, path, cookies: {} } as any;
  }

  function mockRes() {
    const res: any = { statusCode: 0 };
    res.status = (code: number) => {
      res.statusCode = code;
      return res;
    };
    res.json = vi.fn().mockReturnValue(res);
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
});
