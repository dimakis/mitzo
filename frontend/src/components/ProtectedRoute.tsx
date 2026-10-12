import { Navigate, useLocation } from 'react-router-dom';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AUTH_LOST_EVENT,
  AUTH_RESTORED_EVENT,
  isCrossTabAuthEvent,
  isLogoutPending,
  restoreCookieAuthentication,
} from '../lib/api-fetch';
import { hideSplash } from '../lib/splash';
import { saveTokenToWatch } from '../lib/watch-auth';
import { APP_FOREGROUND_EVENT } from '../lib/app-lifecycle-events';

const AUTH_RECOVERY_DELAYS_MS = [1_000, 2_000, 4_000] as const;

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const [auth, setAuth] = useState<'loading' | 'ok' | 'denied' | 'unavailable'>('loading');
  const [attempt, setAttempt] = useState(0);
  const automaticRetries = useRef(0);
  const recoveryRequested = useRef(false);
  const retry = useCallback(() => {
    if (recoveryRequested.current) return;
    recoveryRequested.current = true;
    setAuth('loading');
    setAttempt((value) => value + 1);
  }, []);
  useEffect(() => {
    recoveryRequested.current = false;
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
  useEffect(() => {
    if (auth === 'ok') automaticRetries.current = 0;
    if (auth !== 'unavailable') return;
    const delay = AUTH_RECOVERY_DELAYS_MS[automaticRetries.current];
    if (delay === undefined) return;
    const timer = setTimeout(() => {
      if (document.visibilityState !== 'visible') return;
      automaticRetries.current++;
      retry();
    }, delay);
    return () => clearTimeout(timer);
  }, [auth, retry]);
  useEffect(() => {
    const recover = () => {
      if (auth !== 'unavailable' || document.visibilityState !== 'visible') return;
      automaticRetries.current = 0;
      retry();
    };
    window.addEventListener(APP_FOREGROUND_EVENT, recover);
    window.addEventListener('online', recover);
    document.addEventListener('visibilitychange', recover);
    return () => {
      window.removeEventListener(APP_FOREGROUND_EVENT, recover);
      window.removeEventListener('online', recover);
      document.removeEventListener('visibilitychange', recover);
    };
  }, [auth, retry]);
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
            automaticRetries.current = 0;
            retry();
          }}
        >
          Retry
        </button>
      </div>
    );
  }
  return <>{children}</>;
}
