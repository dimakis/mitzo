import { isLogoutPending, restoreCookieAuthentication } from './api-fetch';

/** Start network wake-up alongside page chunks, sharing the route's fenced promise. */
export function startAuthentication(pathname: string): Promise<void> {
  if (pathname === '/login' || isLogoutPending()) return Promise.resolve();
  performance.mark('mitzo:startup-auth-start');
  return restoreCookieAuthentication().then(
    () => {
      performance.mark('mitzo:startup-auth-settled');
    },
    () => {
      performance.mark('mitzo:startup-auth-unavailable');
    },
  );
}
