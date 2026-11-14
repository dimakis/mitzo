import { restoreCookieAuthentication } from '../../frontend/src/lib/api-fetch';

// The ordinary host consumes startup's verified login identity. Exercise that
// startup owner against the intercepted auth response before mounting the actual
// responsive route; never inject a successful host/auth state directly.
void restoreCookieAuthentication().then((ready) => {
  if (!ready) throw Error('Offline ordinary render login unavailable');
  return import('./repository-preparation-recovery');
});
