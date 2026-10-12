import { Navigate, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import {
  AUTH_LOST_EVENT,
  AUTH_RESTORED_EVENT,
  isCrossTabAuthEvent,
  isLogoutPending,
  restoreCookieAuthentication,
} from '../lib/api-fetch';
import { hideSplash } from '../lib/splash';
import { saveTokenToWatch } from '../lib/watch-auth';

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const [auth, setAuth] = useState<'loading' | 'ok' | 'denied' | 'unavailable'>('loading');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    // The rendered auth status/retry UI must remain visible while the network waits.
    void hideSplash();
    let ignoreCheckResult = false;
    const onAuthLost = () => {
      ignoreCheckResult = true;
      localStorage.removeItem('mitzo_auth_token');
      setAuth('denied');
    };
    const onAuthRestored = (event: Event) => {
      if (!isCrossTabAuthEvent(event)) return;
      ignoreCheckResult = true;
      setAuth('loading');
      setAttempt((value) => value + 1);
    };
    window.addEventListener(AUTH_LOST_EVENT, onAuthLost);
    window.addEventListener(AUTH_RESTORED_EVENT, onAuthRestored);
    if (isLogoutPending()) {
      onAuthLost();
      return () => {
        window.removeEventListener(AUTH_LOST_EVENT, onAuthLost);
        window.removeEventListener(AUTH_RESTORED_EVENT, onAuthRestored);
      };
    }
    restoreCookieAuthentication()
      .then((authenticated) => {
        if (ignoreCheckResult) return;
        setAuth(authenticated ? 'ok' : 'denied');
        if (authenticated) {
          const token = localStorage.getItem('mitzo_auth_token');
          if (token) saveTokenToWatch(token);
        }
      })
      .catch(() => {
        if (!ignoreCheckResult) setAuth('unavailable');
      });
    return () => {
      ignoreCheckResult = true;
      window.removeEventListener(AUTH_LOST_EVENT, onAuthLost);
      window.removeEventListener(AUTH_RESTORED_EVENT, onAuthRestored);
    };
  }, [attempt]);
  if (auth === 'denied')
    return (
      <Navigate
        to={`/login?returnTo=${encodeURIComponent(location.pathname + location.search + location.hash)}`}
        replace
      />
    );
  if (auth === 'loading') {
    return <div className="auth-status">Checking authentication…</div>;
  }
  if (auth === 'unavailable') {
    return (
      <div className="auth-status" role="alert">
        <p>Mitzo could not be reached. Check your connection and try again.</p>
        <button
          className="btn-primary"
          onClick={() => {
            setAuth('loading');
            setAttempt((value) => value + 1);
          }}
        >
          Retry
        </button>
      </div>
    );
  }
  return <>{children}</>;
}
