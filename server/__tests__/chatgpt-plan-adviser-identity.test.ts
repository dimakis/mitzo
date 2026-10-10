import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from 'jose';
import { ChatGptPlanAdviserAccounts } from '../chatgpt-plan-adviser.js';
const keys = vi.hoisted(() => ({ public: null as JWK | null }));
vi.mock('jose', async () => {
  const actual = await vi.importActual<typeof import('jose')>('jose');
  return {
    ...actual,
    createRemoteJWKSet: () => actual.createLocalJWKSet({ keys: [keys.public!] }),
  };
});
let privateKey: KeyLike;
beforeAll(async () => {
  const generated = await generateKeyPair('RS256');
  privateKey = generated.privateKey;
  keys.public = await exportJWK(generated.publicKey);
});
afterEach(() => vi.unstubAllGlobals());
it.each(['valid', 'wrong-nonce', 'wrong-audience', 'expired', 'wrong-issuer', 'foreign-jwks'])(
  'uses real signature validation and rejects %s identity without inference',
  async (kind) => {
    let idToken = '';
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('openid-configuration'))
        return new Response(
          JSON.stringify({
            issuer: 'https://auth.openai.com',
            jwks_uri:
              kind === 'foreign-jwks'
                ? 'https://untrusted.test/keys'
                : 'https://auth.openai.com/keys',
          }),
        );
      if (String(url).endsWith('/oauth/token'))
        return new Response(
          JSON.stringify({
            access_token: 'synthetic-plan',
            refresh_token: 'synthetic-refresh',
            id_token: idToken,
            expires_in: 3600,
            token_type: 'Bearer',
            scope: 'openid resource.invoke chatgpt.tokens.use.direct',
          }),
        );
      if (String(url).endsWith('/models'))
        return new Response(
          JSON.stringify({
            models: [{ slug: 'gpt-6-luna', display_name: 'Luna', visibility: 'list' }],
          }),
        );
      throw Error('Unexpected network request');
    });
    vi.stubGlobal('fetch', fetcher);
    const service = new ChatGptPlanAdviserAccounts({
      store: { load: () => ({ hostId: 'urn:uuid:test', accounts: [] }), save: () => {} },
    });
    const url = new URL(
      service.begin('operator', 'http://127.0.0.1:1455/auth/callback', 'Personal'),
    );
    const now = Math.floor(Date.now() / 1000);
    idToken = await new SignJWT({
      email: 'user@example.test',
      nonce: kind === 'wrong-nonce' ? 'another' : url.searchParams.get('nonce'),
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('verified-subject')
      .setIssuer(kind === 'wrong-issuer' ? 'https://untrusted.test' : 'https://auth.openai.com')
      .setAudience(kind === 'wrong-audience' ? 'another-app' : 'oaiapp_test')
      .setIssuedAt(now)
      .setExpirationTime(kind === 'expired' ? now - 60 : now + 3600)
      .sign(privateKey);
    const callback = new URL('http://127.0.0.1:1455/auth/callback');
    callback.search = new URLSearchParams({
      state: url.searchParams.get('state')!,
      code: 'synthetic-code',
      client_id: 'oaiapp_test',
    }).toString();
    const completion = service.complete('operator', callback, new AbortController().signal);
    if (kind === 'valid') {
      await completion;
      expect(service.catalog()[0].models[0].id).toBe('gpt-6-luna');
    } else {
      await expect(completion).rejects.toThrow();
      expect(service.catalog()).toEqual([]);
      expect(fetcher.mock.calls.some(([request]) => String(request).endsWith('/models'))).toBe(
        false,
      );
    }
    expect(fetcher.mock.calls.every(([request]) => !String(request).endsWith('/responses'))).toBe(
      true,
    );
  },
);
