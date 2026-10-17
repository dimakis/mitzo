import { beforeEach, expect, it, vi } from 'vitest';
const restore = vi.hoisted(() => vi.fn());
const logout = vi.hoisted(() => vi.fn());
vi.mock('../api-fetch', () => ({ restoreCookieAuthentication: restore, isLogoutPending: logout }));
import { startAuthentication } from '../startup-auth';
beforeEach(() => {
  restore.mockReset().mockResolvedValue(true);
  logout.mockReturnValue(false);
});
it('begins authentication synchronously before page code is loaded', () => {
  startAuthentication('/');
  expect(restore).toHaveBeenCalledOnce();
});
it('does not attempt to restore a logged-out or login screen', () => {
  startAuthentication('/login');
  logout.mockReturnValue(true);
  startAuthentication('/');
  expect(restore).not.toHaveBeenCalled();
});
it('leaves network failure to the route recovery UI without an unhandled rejection', async () => {
  restore.mockRejectedValue(new Error('offline'));
  await expect(startAuthentication('/')).resolves.toBeUndefined();
});
