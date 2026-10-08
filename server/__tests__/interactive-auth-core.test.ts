import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';

vi.mock('fs', () => {
  throw Error('core imported filesystem');
});
vi.mock('node:fs', () => {
  throw Error('core imported filesystem');
});
vi.mock('../internal-token.js', () => {
  throw Error('core imported internal-token');
});
vi.mock('../logger.js', () => {
  throw Error('core imported logger');
});
vi.mock('../app.js', () => {
  throw Error('core imported app');
});
vi.mock('../symposium-custodian-authority.js', () => {
  throw Error('core imported custodian');
});
import { createInteractiveAuth } from '../interactive-auth-core.js';

const config = {
  passphrase: 'synthetic-recovery-passphrase',
  secret: 'synthetic-recovery-secret-at-least-32-bytes',
  maxAgeHours: 1,
  cookieName: 'synthetic_recovery',
  realm: { issuer: 'synthetic-recovery-issuer', audience: 'synthetic-recovery-audience' },
};
const request = (headers = {}, cookies = {}) => ({
  headers,
  cookies,
  path: '/protected',
  query: {},
});
afterEach(() => vi.useRealTimers());

describe('configured interactive auth', () => {
  it('imports and creates without ambient configuration or privileged modules', async () => {
    vi.stubEnv('AUTH_SECRET', '');
    try {
      expect(createInteractiveAuth(config).verifyPassphrase(config.passphrase)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('binds JWT issuer/audience/secret and cookie realm, rejecting normal/legacy/privileged credentials', async () => {
    const recovery = createInteractiveAuth(config);
    const normal = createInteractiveAuth({ ...config, cookieName: 'cc_auth', realm: undefined });
    const token = (await recovery.login(config.passphrase))!;
    expect(await recovery.login('wrong')).toBeNull();
    expect(await recovery.authenticateToken(token)).not.toBeNull();
    expect(await recovery.authenticateToken((await normal.login(config.passphrase))!)).toBeNull();
    for (const claims of [
      { iss: 'wrong', aud: config.realm.audience },
      { iss: config.realm.issuer, aud: 'wrong' },
    ]) {
      const foreign = await new SignJWT({ sub: 'user', ...claims })
        .setProtectedHeader({ alg: 'HS256' })
        .setJti('synthetic')
        .setExpirationTime('1h')
        .sign(new TextEncoder().encode(config.secret));
      expect(await recovery.authenticateToken(foreign)).toBeNull();
    }
    const legacy = await new SignJWT({
      sub: 'user',
      iss: config.realm.issuer,
      aud: config.realm.audience,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(config.secret));
    expect(await recovery.authenticateToken(legacy)).toBeNull();
    expect(await normal.authenticateToken(legacy)).not.toBeNull();
    expect(
      await recovery.authenticateRequest(
        request(
          { 'x-internal-token': 'synthetic', 'x-custodian-token': 'synthetic' },
          { cc_auth: token },
        ),
      ),
    ).toBeNull();
    expect(
      await recovery.authenticateRequest(request({}, { synthetic_recovery: token })),
    ).not.toBeNull();
    expect(
      await recovery.authenticateRequest(
        request({ authorization: 'Bearer invalid' }, { synthetic_recovery: token }),
      ),
    ).toBeNull();
    expect(
      await createInteractiveAuth({
        ...config,
        secret: 'synthetic-other-secret-at-least-32-bytes',
      }).authenticateToken(token),
    ).toBeNull();
  });
  it('retains normal no-jti legacy identity and explicit SSE/WS credential precedence', async () => {
    const auth = createInteractiveAuth({ ...config, realm: undefined });
    const token = await new SignJWT({ sub: 'user' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(config.secret));
    const session = await auth.authenticateToken(token);
    expect(session?.id).toBeTruthy();
    expect(await auth.authenticateToken(token)).toEqual(session);
    expect(await auth.authenticateWs(`synthetic_recovery=${token}`, 'invalid')).toBeNull();
    expect(await auth.verifyWsAuth(`other=x; synthetic_recovery=${token}`)).toBe(true);
    expect(
      await auth.authenticateRequest({
        ...request({}, { synthetic_recovery: token }),
        path: '/events',
        query: { token: ['invalid'] },
      }),
    ).toBeNull();
    expect(
      await auth.authenticateRequest({
        ...request({}, { synthetic_recovery: token }),
        query: { token: 'ignored' },
      }),
    ).toEqual(session);
  });
  it('enforces expiry, immediate revocation, unregister and isolated session registries', async () => {
    vi.useFakeTimers();
    const auth = createInteractiveAuth(config),
      other = createInteractiveAuth(config);
    const token = (await auth.login(config.passphrase))!,
      session = (await auth.authenticateToken(token))!;
    const notify = vi.fn(),
      detached = vi.fn();
    const unregister = auth.registerAuthSession(session, detached);
    unregister();
    auth.registerAuthSession(session, notify);
    auth.revokeAuthSession(session);
    expect(notify).toHaveBeenCalledWith('revoked');
    expect(detached).not.toHaveBeenCalled();
    expect(await auth.authenticateToken(token)).toBeNull();
    expect(await other.authenticateToken(token)).not.toBeNull();
    const expired = vi.fn();
    other.registerAuthSession(session, expired);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(expired).toHaveBeenCalledWith('expired');
    expect(await other.authenticateToken(token)).toBeNull();
  });
  it('rejects incomplete or normal-cookie recovery realms without creating a factory', () => {
    for (const patch of [
      { realm: { issuer: '', audience: 'x' } },
      { realm: { issuer: 'x', audience: '' } },
      { cookieName: 'cc_auth' },
      { secret: 'short' },
      { maxAgeHours: 0 },
    ]) {
      expect(() => createInteractiveAuth({ ...config, ...patch })).toThrow();
    }
  });
});
