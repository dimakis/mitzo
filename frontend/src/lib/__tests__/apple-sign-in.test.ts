import { beforeEach, describe, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ enabled: false, available: true, authorize: vi.fn() }));
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => native.enabled,
    getPlatform: () => 'ios',
    isPluginAvailable: () => native.available,
  },
  registerPlugin: () => ({ authorize: native.authorize }),
}));
import {
  beginAppleSignIn,
  readAppleSignInStatus,
  verifyAppleBrowserSession,
} from '../apple-sign-in';

const fetcher = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', fetcher);
  fetcher.mockReset();
  native.authorize.mockReset();
  native.enabled = false;
  native.available = true;
});
describe('Apple login client adapter', () => {
  it('uses only the returned Apple URL and never sends existing bearer credentials', async () => {
    fetcher.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          authorizationUrl: 'https://appleid.apple.com/auth/authorize?state=server-state',
        }),
      ),
    );
    expect(await beginAppleSignIn()).toEqual({
      kind: 'redirect',
      url: 'https://appleid.apple.com/auth/authorize?state=server-state',
    });
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBeUndefined();
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ client: 'web' });
  });
  it('rejects a substituted redirect destination', async () => {
    fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify({ authorizationUrl: 'https://attacker.example' })),
    );
    await expect(beginAppleSignIn()).rejects.toThrow();
  });
  it('binds native authorization to the server challenge and sends no identity token', async () => {
    native.enabled = true;
    fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify({ state: 'state', nonce: 'nonce', verifier: 'verifier' })),
    );
    native.authorize.mockResolvedValueOnce({ state: 'state', code: 'apple-code' });
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ token: 'mitzo-token' })));
    expect(await beginAppleSignIn('owner-proof')).toEqual({
      kind: 'session',
      token: 'mitzo-token',
    });
    expect(native.authorize).toHaveBeenCalledWith({ state: 'state', nonce: 'nonce' });
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
      state: 'state',
      verifier: 'verifier',
      code: 'apple-code',
    });
  });
  it('refuses mismatched native state before exchanging the code', async () => {
    native.enabled = true;
    fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify({ state: 'state', nonce: 'nonce', verifier: 'verifier' })),
    );
    native.authorize.mockResolvedValueOnce({ state: 'other', code: 'code' });
    await expect(beginAppleSignIn()).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('keeps provider failures visible and treats unavailable plugins as an upgrade requirement', async () => {
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'no' }), { status: 503 }));
    await expect(readAppleSignInStatus()).rejects.toThrow();
    native.enabled = true;
    native.available = false;
    await expect(beginAppleSignIn()).rejects.toThrow(/Update/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('requires actual cookie verification after a browser return, including a valid response body', async () => {
    fetcher.mockResolvedValueOnce(new Response('{}', { status: 401 }));
    await expect(verifyAppleBrowserSession()).rejects.toThrow();
    fetcher.mockResolvedValueOnce(new Response('<html>not an API response</html>'));
    await expect(verifyAppleBrowserSession()).rejects.toThrow();
    fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, authSessionId: 'verified-session' })),
    );
    await expect(verifyAppleBrowserSession()).resolves.toBeUndefined();
    expect(fetcher.mock.calls[2][1].credentials).toBe('include');
    expect(fetcher.mock.calls[2][1].headers).toBeUndefined();
  });
});
