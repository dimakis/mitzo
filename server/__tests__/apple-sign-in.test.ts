import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, SignJWT, exportPKCS8 } from 'jose';
import { createAppleSignIn, AppleSignInError } from '../apple-sign-in.js';
import { AppleOwnerStore } from '../apple-owner-store.js';
import { loadAppleSignInConfig, createAppleVerifier } from '../apple-sign-in-provider.js';
import { createInteractiveAuth } from '../interactive-auth-core.js';

const directories: string[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'mitzo-apple-test-'));
  directories.push(path);
  return path;
}
afterEach(() => directories.splice(0).forEach((path) => rmSync(path, { recursive: true })));
const config = {
  clientId: 'com.example.mitzo.web',
  nativeClientId: 'com.example.mitzo',
  teamId: 'TEAM123456',
  keyId: 'KEY1234567',
  privateKeyPath: '/not-read-in-test.p8',
  redirectUri: 'https://mitzo.example/api/auth/apple/callback',
};
function fixture() {
  const store = new AppleOwnerStore(join(directory(), 'apple-owner.json'));
  const verify = vi.fn(async () => ({ subject: 'apple-owner' }));
  const issueSession = vi.fn(async () => 'mitzo-session');
  let time = Date.now();
  const service = createAppleSignIn({
    config,
    store,
    verify,
    issueSession,
    verifyPassphrase: (value) => value === 'owner-proof',
    now: () => time,
  });
  return {
    store,
    verify,
    issueSession,
    service,
    advance: () => {
      time += 301_000;
    },
  };
}

describe('owner-only Apple sign-in', () => {
  it('requires explicit owner proof before enrollment and does not trust an email', async () => {
    const f = fixture();
    expect(() => f.service.start('web')).toThrow('enrollment_required');
    expect(() => f.service.start('web', 'wrong')).toThrow('enrollment_denied');
    const start = f.service.start('web', 'owner-proof');
    const url = new URL(start.authorizationUrl!);
    expect(url.origin).toBe('https://appleid.apple.com');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('response_mode')).toBe('query');
    expect(url.searchParams.has('scope')).toBe(false);
    expect(
      await f.service.finish({
        client: 'web',
        state: start.state,
        verifier: start.verifier,
        code: 'one-use-code',
      }),
    ).toBe('mitzo-session');
    expect(f.store.read()).toBe('apple-owner');
    expect(new AppleOwnerStore(f.store.path).read()).toBe('apple-owner');
    expect(f.verify).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: config.clientId,
        nonce: start.nonce,
        redirectUri: config.redirectUri,
      }),
    );
  });

  it('refuses a different Apple account and does not replace the existing owner', async () => {
    const f = fixture();
    f.store.enroll('original-owner');
    const start = f.service.start('web');
    await expect(f.service.finish({ client: 'web', ...start, code: 'code' })).rejects.toMatchObject(
      { code: 'owner_mismatch' },
    );
    expect(f.issueSession).not.toHaveBeenCalled();
    expect(f.store.read()).toBe('original-owner');
    expect(() => f.service.start('web', 'owner-proof')).toThrow('already_enrolled');
  });

  it('rejects callback injection, wrong client, expiry and replay before issuing authority', async () => {
    const f = fixture();
    f.store.enroll('apple-owner');
    const start = f.service.start('web');
    await expect(
      f.service.finish({ client: 'web', ...start, verifier: 'wrong', code: 'code' }),
    ).rejects.toMatchObject({ code: 'invalid_transaction' });
    await expect(
      f.service.finish({ ...start, client: 'native', code: 'code' }),
    ).rejects.toMatchObject({ code: 'invalid_transaction' });
    expect(f.verify).not.toHaveBeenCalled();
    await f.service.finish({ client: 'web', ...start, code: 'code' });
    await expect(f.service.finish({ client: 'web', ...start, code: 'code' })).rejects.toMatchObject(
      { code: 'invalid_transaction' },
    );
    const expired = f.service.start('web');
    f.advance();
    await expect(
      f.service.finish({ client: 'web', ...expired, code: 'code' }),
    ).rejects.toMatchObject({ code: 'invalid_transaction' });
    expect(f.issueSession).toHaveBeenCalledTimes(1);
  });

  it('uses a distinct native audience and refuses authority that expires during exchange', async () => {
    const f = fixture();
    f.store.enroll('apple-owner');
    const start = f.service.start('native');
    f.verify.mockImplementationOnce(async () => {
      f.advance();
      return { subject: 'apple-owner' };
    });
    await expect(
      f.service.finish({ client: 'native', ...start, code: 'native-code' }),
    ).rejects.toMatchObject({ code: 'invalid_transaction' });
    expect(f.verify).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: config.nativeClientId,
        redirectUri: undefined,
      }),
    );
    expect(f.issueSession).not.toHaveBeenCalled();
  });

  it('rechecks owner storage after the provider await and fails closed on unreadable state', async () => {
    const f = fixture();
    f.store.enroll('apple-owner');
    const start = f.service.start('web');
    f.verify.mockImplementationOnce(async () => {
      writeFileSync(f.store.path, 'corrupt');
      return { subject: 'apple-owner' };
    });
    await expect(f.service.finish({ client: 'web', ...start, code: 'code' })).rejects.toThrow();
    expect(f.issueSession).not.toHaveBeenCalled();
    expect(() => f.service.status()).toThrow();
  });

  it('consumes cancellation without calling Apple or minting a session', async () => {
    const f = fixture();
    f.store.enroll('apple-owner');
    const start = f.service.start('web');
    await expect(
      f.service.finish({ client: 'web', ...start, error: 'user_cancelled_authorize' }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(f.verify).not.toHaveBeenCalled();
    await expect(f.service.finish({ client: 'web', ...start, code: 'code' })).rejects.toMatchObject(
      { code: 'invalid_transaction' },
    );
  });

  it('keeps new sessions subject to existing expiry and logout revocation', async () => {
    const auth = createInteractiveAuth({
      passphrase: 'test-owner-proof',
      secret: 'synthetic-secret-with-at-least-32-bytes',
      maxAgeHours: 1,
      cookieName: 'cc_auth',
    });
    const token = await auth.issueOperatorSession();
    const session = await auth.authenticateToken(token);
    expect(session).not.toBeNull();
    const invalidated = vi.fn();
    auth.registerAuthSession(session!, invalidated);
    auth.revokeAuthSession(session!);
    expect(await auth.authenticateToken(token)).toBeNull();
    expect(invalidated).toHaveBeenCalledWith('revoked');
  });
});

describe('Apple provider validation', () => {
  it('disables absent configuration and refuses partial or non-HTTPS callbacks', () => {
    expect(loadAppleSignInConfig({})).toBeNull();
    expect(() => loadAppleSignInConfig({ MITZO_APPLE_CLIENT_ID: config.clientId })).toThrow();
    const env = {
      MITZO_APPLE_CLIENT_ID: config.clientId,
      MITZO_APPLE_TEAM_ID: config.teamId,
      MITZO_APPLE_KEY_ID: config.keyId,
      MITZO_APPLE_PRIVATE_KEY_PATH: config.privateKeyPath,
      MITZO_APPLE_REDIRECT_URI: config.redirectUri,
    };
    expect(loadAppleSignInConfig(env)?.clientId).toBe(config.clientId);
    for (const value of [
      'http://mitzo.example/api/auth/apple/callback',
      'https://localhost/api/auth/apple/callback',
      'https://127.0.0.1/api/auth/apple/callback',
      'https://mitzo.example/other',
      'https://mitzo.example/api/auth/apple/callback?next=bad',
    ]) {
      expect(() => loadAppleSignInConfig({ ...env, MITZO_APPLE_REDIRECT_URI: value })).toThrow();
    }
  });

  it.each([
    'signature',
    'issuer',
    'audience',
    'nonce',
    'expired',
    'missing-subject',
    'missing-expiry',
  ])('rejects %s from the code exchange', async (fault) => {
    const signing = await generateKeyPair('RS256');
    const other = await generateKeyPair('RS256');
    const client = await generateKeyPair('ES256', { extractable: true });
    const token = new SignJWT({ nonce: fault === 'nonce' ? 'wrong' : 'expected' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(fault === 'issuer' ? 'https://attacker.example' : 'https://appleid.apple.com')
      .setAudience(fault === 'audience' ? 'other-client' : config.clientId)
      .setIssuedAt();
    if (fault !== 'missing-expiry') token.setExpirationTime(fault === 'expired' ? '0s' : '5m');
    if (fault !== 'missing-subject') token.setSubject('apple-owner');
    const idToken = await token.sign(fault === 'signature' ? other.privateKey : signing.privateKey);
    const exchange = vi.fn(
      async () => new Response(JSON.stringify({ id_token: idToken }), { status: 200 }),
    );
    const verify = createAppleVerifier(config, {
      fetch: exchange,
      key: async () => signing.publicKey,
      privateKey: async () => exportPKCS8(client.privateKey),
    });
    await expect(
      verify({
        clientId: config.clientId,
        nonce: 'expected',
        code: 'code',
        redirectUri: config.redirectUri,
      }),
    ).rejects.toBeInstanceOf(AppleSignInError);
  });

  it('redeems the code server-side with a bounded signed client credential', async () => {
    const signing = await generateKeyPair('RS256');
    const client = await generateKeyPair('ES256', { extractable: true });
    const token = await new SignJWT({ nonce: 'expected' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer('https://appleid.apple.com')
      .setAudience(config.clientId)
      .setSubject('apple-owner')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(signing.privateKey);
    const exchange = vi.fn(
      async () => new Response(JSON.stringify({ id_token: token }), { status: 200 }),
    );
    const verify = createAppleVerifier(config, {
      fetch: exchange,
      key: async () => signing.publicKey,
      privateKey: async () => exportPKCS8(client.privateKey),
    });
    expect(
      await verify({
        clientId: config.clientId,
        nonce: 'expected',
        code: 'code',
        redirectUri: config.redirectUri,
      }),
    ).toEqual({ subject: 'apple-owner' });
    const [url, request] = exchange.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://appleid.apple.com/auth/token');
    expect(request.redirect).toBe('error');
    const form = new URLSearchParams(String(request.body));
    expect(form.get('client_id')).toBe(config.clientId);
    expect(form.get('redirect_uri')).toBe(config.redirectUri);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('client_secret')?.split('.')).toHaveLength(3);
  });
});
