// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as auth from '../api-fetch';

const fetchMock = vi.fn();
const key = 'mitzo-conversation-joining-recovery:offline-source';
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  auth.markAuthLost();
  fetchMock
    .mockReset()
    .mockImplementation(async () => Response.json({ ok: true, authSessionId: 'login-one' }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('selects only the interactive session identity from a completed ordinary auth check', async () => {
  expect(auth.currentVerifiedAuthSessionId()).toBeUndefined();
  expect(await auth.restoreCookieAuthentication()).toBe(true);
  expect(auth.currentVerifiedAuthSessionId()).toBe('login-one');
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(await auth.restoreCookieAuthentication()).toBe(true);
  expect(auth.currentVerifiedAuthSessionId()).toBe('login-one');
  expect(fetchMock).toHaveBeenCalledOnce();
});

it.each([{}, { authSessionId: '' }, { authSessionId: { token: 'private' } }])(
  'keeps older authentication working without inventing a durable joining identity: %j',
  async (body) => {
    fetchMock.mockResolvedValueOnce(Response.json({ ok: true, ...body }));
    expect(await auth.restoreCookieAuthentication()).toBe(true);
    expect(auth.currentVerifiedAuthSessionId()).toBeUndefined();
  },
);

it('retains joining correlation state through ordinary same-session cookie checks', async () => {
  await auth.restoreCookieAuthentication();
  sessionStorage.setItem(key, 'retained-original-operation');
  vi.useFakeTimers();
  await vi.advanceTimersByTimeAsync(30_001);
  expect(await auth.restoreCookieAuthentication()).toBe(true);
  expect(sessionStorage.getItem(key)).toBe('retained-original-operation');
  expect(auth.currentVerifiedAuthSessionId()).toBe('login-one');
});

it.each(['lost', 'new-login', 'cross-tab-token', 'cross-tab-logout'])(
  'centrally clears joining state and verified identity on %s without a mounted joining hook',
  async (change) => {
    await auth.restoreCookieAuthentication();
    sessionStorage.setItem(key, 'retained-original-operation');
    sessionStorage.setItem('unrelated-draft', 'keep');
    if (change === 'lost') auth.markAuthLost();
    else if (change === 'new-login') auth.loginSucceeded('new-private-token');
    else
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: change === 'cross-tab-token' ? 'mitzo_auth_token' : 'mitzo_logout_pending',
          newValue: change === 'cross-tab-token' ? 'new-private-token' : '1',
          storageArea: localStorage,
        }),
      );
    expect(sessionStorage.getItem(key)).toBeNull();
    expect(sessionStorage.getItem('unrelated-draft')).toBe('keep');
    expect(auth.currentVerifiedAuthSessionId()).toBeUndefined();
  },
);

it('does not adopt an identity from a body completed after a newer login', async () => {
  let finish!: (body: unknown) => void;
  const body = new Promise((resolve) => {
    finish = resolve;
  });
  fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: () => body });
  const pending = auth.restoreCookieAuthentication();
  await Promise.resolve();
  auth.loginSucceeded('new-private-token');
  finish({ ok: true, authSessionId: 'stale-login' });
  expect(await pending).toBe(false);
  expect(auth.currentVerifiedAuthSessionId()).toBeUndefined();
  fetchMock.mockResolvedValueOnce(Response.json({ ok: true, authSessionId: 'new-login' }));
  expect(await auth.restoreCookieAuthentication()).toBe(true);
  expect(auth.currentVerifiedAuthSessionId()).toBe('new-login');
});

it('fences an in-flight same-cookie check when an explicit login replaces an already restored login', async () => {
  await auth.restoreCookieAuthentication();
  vi.useFakeTimers();
  await vi.advanceTimersByTimeAsync(30_001);
  let finish!: (body: unknown) => void;
  const body = new Promise((resolve) => {
    finish = resolve;
  });
  fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: () => body });
  const pending = auth.restoreCookieAuthentication();
  await Promise.resolve();
  auth.loginSucceeded();
  finish({ ok: true, authSessionId: 'old-cookie-login' });
  expect(await pending).toBe(false);
  expect(auth.currentVerifiedAuthSessionId()).toBeUndefined();
});

it('invalidates an already restored cookie login from another tab while the joining hook is unmounted', async () => {
  await auth.restoreCookieAuthentication();
  sessionStorage.setItem(key, 'retained-original-operation');
  window.dispatchEvent(
    new StorageEvent('storage', {
      key: 'mitzo_auth_restored_signal',
      newValue: 'login:other-tab',
      storageArea: localStorage,
    }),
  );
  expect(sessionStorage.getItem(key)).toBeNull();
  expect(auth.currentVerifiedAuthSessionId()).toBeUndefined();
});

it('removes prior recovery identity and correlation after an explicit forbidden auth check', async () => {
  await auth.restoreCookieAuthentication();
  sessionStorage.setItem(key, 'retained-original-operation');
  vi.useFakeTimers();
  await vi.advanceTimersByTimeAsync(30_001);
  fetchMock.mockResolvedValueOnce(new Response('{}', { status: 403 }));
  expect(await auth.restoreCookieAuthentication()).toBe(false);
  expect(auth.currentVerifiedAuthSessionId()).toBeUndefined();
  expect(sessionStorage.getItem(key)).toBeNull();
});

it('invalidates the prior verified identity when the server selects a different session', async () => {
  await auth.restoreCookieAuthentication();
  sessionStorage.setItem(key, 'retained-original-operation');
  vi.useFakeTimers();
  await vi.advanceTimersByTimeAsync(30_001);
  fetchMock.mockResolvedValueOnce(Response.json({ ok: true, authSessionId: 'other-login' }));
  expect(await auth.restoreCookieAuthentication()).toBe(true);
  expect(auth.currentVerifiedAuthSessionId()).toBe('other-login');
  expect(sessionStorage.getItem(key)).toBeNull();
});
