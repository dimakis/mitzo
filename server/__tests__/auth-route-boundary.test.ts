import type { Request, Response, RequestHandler } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { authenticationRoute } from '../auth-route-boundary.js';
import { createInteractiveAuth } from '../interactive-auth-core.js';

function invoke(handler: RequestHandler) {
  const response = {
    headersSent: false,
    statusCode: 200,
    body: undefined as unknown,
    cookie: vi.fn(),
    clearCookie: vi.fn(),
    status(value: number) {
      this.statusCode = value;
      return this;
    },
    json(value: unknown) {
      this.body = value;
      finish();
      return this;
    },
  };
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  handler({} as Request, response as unknown as Response, vi.fn());
  return completed.then(() => response);
}

describe('authentication HTTP failure boundary', () => {
  it('contains a failed login without replacing an existing cookie or exposing the error', async () => {
    const warn = vi.fn();
    const response = await invoke(
      authenticationRoute(
        async () => {
          throw Error('secret signing failure');
        },
        { warn },
      ),
    );
    expect(response.statusCode).toBe(503);
    expect(response.body).toEqual({ error: 'Authentication service unavailable. Try again.' });
    expect(response.cookie).not.toHaveBeenCalled();
    expect(response.clearCookie).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('Authentication request failed');
  });

  it('clears the cookie and reports unconfirmed logout while retaining fail-closed revocation', async () => {
    const auth = createInteractiveAuth({
      passphrase: 'offline passphrase',
      secret: 'offline-test-secret-at-least-32-characters',
      maxAgeHours: 1,
      cookieName: 'test_auth',
    });
    const session = (await auth.authenticateToken((await auth.login('offline passphrase'))!))!;
    auth.setRevocationStore({
      isAuthSessionRevoked: () => false,
      revokeAuthSession: () => {
        throw Error('private database path');
      },
    });
    const response = await invoke(
      authenticationRoute(
        async (_req, res) => {
          auth.revokeOperatorSessions([session]);
          res.json({ ok: true });
        },
        { warn: vi.fn(), logoutCookie: 'test_auth' },
      ),
    );
    expect(response.statusCode).toBe(503);
    expect(response.body).toEqual({
      error: 'Logout revocation could not be confirmed. Try again.',
    });
    expect(response.clearCookie).toHaveBeenCalledWith('test_auth', {
      httpOnly: true,
      sameSite: 'strict',
    });
    expect(auth.isSessionRevoked(session)).toBe(true);
  });
});
