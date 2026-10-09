// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { apiFetch, AUTH_LOST_EVENT } from '../api-fetch';
import {
  completeConnectionSetup,
  getCachedCredentialAuthorization,
  reauthorizeKeychain,
} from '../credential-connections-api';
vi.mock('../api-fetch', () => ({ apiFetch: vi.fn(), AUTH_LOST_EVENT: 'mitzo:auth-lost' }));
beforeEach(() => {
  vi.resetAllMocks();
  window.dispatchEvent(new Event(AUTH_LOST_EVENT));
});
it('reuses short-lived authorization only in memory and expires it', async () => {
  const now = Date.now();
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ csrf: 'fixture-csrf', expiresAt: now + 60_000 })),
  );
  const storage = vi.spyOn(Storage.prototype, 'setItem');
  await reauthorizeKeychain('fixture-passphrase');
  expect(getCachedCredentialAuthorization()?.csrf).toBe('fixture-csrf');
  expect(storage).not.toHaveBeenCalled();
  vi.spyOn(Date, 'now').mockReturnValue(now + 60_001);
  expect(getCachedCredentialAuthorization()).toBeUndefined();
  vi.restoreAllMocks();
});
it.each([401, 403])('drops cached authorization after HTTP %i', async (status) => {
  vi.mocked(apiFetch).mockResolvedValueOnce(
    new Response(JSON.stringify({ csrf: 'fixture-csrf', expiresAt: Date.now() + 60_000 })),
  );
  await reauthorizeKeychain('fixture-passphrase');
  vi.mocked(apiFetch).mockResolvedValueOnce(
    new Response(JSON.stringify({ error: 'Authorize again' }), { status }),
  );
  await expect(
    completeConnectionSetup('draft/a', 3, 'fixture-key', 'fixture-csrf'),
  ).rejects.toThrow('Authorize again');
  expect(getCachedCredentialAuthorization()).toBeUndefined();
});
it('sends credentials only to the guarded completion endpoint and clears authorization on logout', async () => {
  vi.mocked(apiFetch).mockResolvedValueOnce(
    new Response(JSON.stringify({ csrf: 'fixture-csrf', expiresAt: Date.now() + 60_000 })),
  );
  await reauthorizeKeychain('fixture-passphrase');
  vi.mocked(apiFetch).mockResolvedValueOnce(
    new Response(JSON.stringify({ setup: { status: 'ready' } })),
  );
  await completeConnectionSetup('draft/a', 3, 'fixture-key', 'fixture-csrf');
  expect(apiFetch).toHaveBeenLastCalledWith(
    '/api/credential-connections/setups/draft%2Fa/complete',
    expect.objectContaining({
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'fixture-csrf' },
      body: JSON.stringify({ revision: 3, secret: 'fixture-key' }),
    }),
  );
  window.dispatchEvent(new Event(AUTH_LOST_EVENT));
  expect(getCachedCredentialAuthorization()).toBeUndefined();
});
