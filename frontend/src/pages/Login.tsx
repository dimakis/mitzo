import { useState, useEffect, useRef, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  apiFetch,
  AUTH_LOST_EVENT,
  AUTH_RESTORED_EVENT,
  getApiBaseUrl,
  getStoredAuthToken,
  isLogoutPending,
  isCrossTabAuthEvent,
  loginSucceeded,
  markAuthLost,
  restoreCookieAuthentication,
} from '../lib/api-fetch';
import {
  isBiometricAvailable,
  getBiometricLabel,
  biometricLogin,
  saveCredentials,
  saveBiometricPassphrase,
} from '../lib/biometric';
import { saveTokenToWatch } from '../lib/watch-auth';
import { notifySuccess } from '../lib/haptics';
import { loginReturnPath } from '../lib/login-return';
import { MitzoBrand } from '../components/MitzoBrand';
import {
  beginAppleSignIn,
  readAppleSignInStatus,
  verifyAppleBrowserSession,
  AppleSignInClientError,
  appleSignInMessage,
  type AppleSignInStatus,
} from '../lib/apple-sign-in';
import '../styles/login-biometric.css';

export function Login() {
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [biometricReady, setBiometricReady] = useState(false);
  const [enableBiometric, setEnableBiometric] = useState(false);
  const [unlockNeedsEnrollment, setUnlockNeedsEnrollment] = useState(false);
  const biometricAttempted = useRef(false);
  const [bioLabel, setBioLabel] = useState('Biometric');
  const [apple, setApple] = useState<AppleSignInStatus | null>(null);
  const [appleStatusFailed, setAppleStatusFailed] = useState(false);
  const [appleRetry, setAppleRetry] = useState(0);
  const attempt = useRef(0);
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = loginReturnPath(new URLSearchParams(location.search).get('returnTo'));
  const appleReturn = new URLSearchParams(location.search).get('apple');
  const appleReason = new URLSearchParams(location.search).get('reason');

  useEffect(() => {
    const lifecycle = attempt;
    const invalidate = () => {
      attempt.current++;
      setSubmitting(false);
    };
    window.addEventListener(AUTH_LOST_EVENT, invalidate);
    return () => {
      lifecycle.current++;
      window.removeEventListener(AUTH_LOST_EVENT, invalidate);
    };
  }, []);

  useEffect(() => {
    let current = true;
    setAppleStatusFailed(false);
    void readAppleSignInStatus().then(
      (status) => {
        if (current) setApple(status);
      },
      () => {
        if (current) setAppleStatusFailed(true);
      },
    );
    return () => {
      current = false;
    };
  }, [appleRetry]);

  useEffect(() => {
    const lifecycle = attempt;
    if (!appleReturn) return;
    if (appleReturn !== 'success') {
      setError(appleSignInMessage(appleReturn === 'cancelled' ? 'cancelled' : appleReason));
      return;
    }
    markAuthLost();
    const current = ++attempt.current;
    setSubmitting(true);
    void verifyAppleBrowserSession()
      .then(() => {
        if (current !== attempt.current) return;
        loginSucceeded();
        navigate(returnTo, { replace: true });
      })
      .catch(() => {
        if (current === attempt.current)
          setError('Apple sign-in could not be confirmed. Try again or use your passphrase.');
      })
      .finally(() => {
        if (current === attempt.current) setSubmitting(false);
      });
    return () => {
      lifecycle.current++;
    };
  }, [appleReturn, appleReason, navigate, returnTo]);

  useEffect(() => {
    const onAuthRestored = (event: Event) => {
      if (isCrossTabAuthEvent(event)) {
        attempt.current++;
        navigate(returnTo, { replace: true });
      }
    };
    window.addEventListener(AUTH_RESTORED_EVENT, onAuthRestored);
    return () => window.removeEventListener(AUTH_RESTORED_EVENT, onAuthRestored);
  }, [navigate, returnTo]);

  useEffect(() => {
    if (appleReturn) return;
    let mounted = true;
    isBiometricAvailable().then((available) => {
      if (!mounted) return;
      setBiometricReady(available);
      if (available)
        void getBiometricLabel().then((label) => {
          if (mounted) setBioLabel(label);
        });
      // Once Apple is offered, identity selection is explicit. An automatic
      // biometric request must not race a new Apple authorization.
      if (available && apple?.enabled === false && !biometricAttempted.current) {
        biometricAttempted.current = true;
        biometricLogin(getApiBaseUrl()).then((token) => {
          if (!mounted) return;
          if (token) {
            notifySuccess();
            navigate(returnTo, { replace: true });
          } else setUnlockNeedsEnrollment(true);
        });
      }
    });
    return () => {
      mounted = false;
    };
  }, [apple, appleReturn, navigate, returnTo]);

  async function handleBiometric() {
    attempt.current++;
    const token = await biometricLogin(getApiBaseUrl());
    if (token) {
      notifySuccess();
      navigate(returnTo, { replace: true });
    } else {
      setUnlockNeedsEnrollment(true);
      setError('Unable to unlock — try again or sign in with your passphrase');
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');

    markAuthLost();
    setSubmitting(true);
    const current = ++attempt.current;
    try {
      const res = await apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passphrase }),
      });
      if (current !== attempt.current) return;

      if (res.ok) {
        const data = (await res.json()) as { token?: string };
        if (data.token) {
          loginSucceeded(data.token);
          if (enableBiometric && !(await saveBiometricPassphrase(passphrase))) {
            setError(`Unable to enable ${bioLabel}. Uncheck the option and sign in to continue.`);
            return;
          }
          await saveCredentials(data.token);
          const restoredToken = data.token;
          void Promise.resolve(
            saveTokenToWatch(
              restoredToken,
              () => !isLogoutPending() && getStoredAuthToken() === restoredToken,
            ),
          ).catch(() => undefined);
        } else loginSucceeded();
        navigate(returnTo, { replace: true });
      } else {
        const restored = await restoreCookieAuthentication().catch(() => false);
        if (restored) {
          navigate(returnTo, { replace: true });
          return;
        }
        setError('Invalid passphrase');
      }
    } catch {
      setError('Unable to reach Mitzo — check your connection and try again');
    } finally {
      if (current === attempt.current) setSubmitting(false);
    }
  }

  async function handleApple() {
    markAuthLost();
    const current = ++attempt.current;
    setSubmitting(true);
    setError('');
    try {
      const result = await beginAppleSignIn(
        apple?.enabled && !apple.enrolled ? passphrase : undefined,
        () => current === attempt.current,
      );
      if (current !== attempt.current) return;
      if (result.kind === 'redirect') {
        window.location.assign(result.url);
        return;
      }
      loginSucceeded(result.token);
      // ProtectedRoute verifies this session and performs the shared Watch sync.
      // Optional native storage must not hold the completed Apple login open.
      navigate(returnTo, { replace: true });
    } catch (cause) {
      if (current === attempt.current) {
        setError(
          cause instanceof AppleSignInClientError ? cause.message : appleSignInMessage(undefined),
        );
      }
    } finally {
      if (current === attempt.current) setSubmitting(false);
    }
  }

  return (
    <div className="login-page">
      <form onSubmit={handleSubmit} className="login-form">
        <MitzoBrand className="login-brand" />
        <h1 className="sr-only">Sign in to Mitzo</h1>
        {apple?.enabled && apple.enrolled && (
          <button
            type="button"
            className="btn-secondary login-apple-button"
            onClick={handleApple}
            disabled={submitting}
            aria-label="Sign in with Apple"
          >
            <img src="/apple-sign-in.png" alt="Sign in with Apple" width="240" height="44" />
          </button>
        )}
        {apple?.enabled && !apple.enrolled && (
          <p className="login-apple-description">
            To connect your Apple account, enter your Mitzo passphrase, then choose Connect Apple
            account.
          </p>
        )}
        <input
          type="password"
          placeholder="Passphrase"
          aria-label="Passphrase"
          autoComplete="current-password"
          disabled={submitting}
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          autoFocus
        />
        {apple?.enabled && !apple.enrolled && (
          <button
            type="button"
            className="btn-secondary"
            onClick={handleApple}
            disabled={submitting || !passphrase}
          >
            Connect Apple account
          </button>
        )}
        {appleStatusFailed && (
          <p className="login-apple-description" role="status">
            Apple sign-in availability could not be checked.{' '}
            <button
              type="button"
              className="btn-secondary"
              disabled={submitting}
              onClick={() => setAppleRetry((value) => value + 1)}
            >
              Retry Apple sign-in
            </button>
          </p>
        )}
        {biometricReady && (
          <div className="login-biometric-enrollment">
            <label>
              <input
                type="checkbox"
                checked={enableBiometric}
                onChange={(event) => setEnableBiometric(event.target.checked)}
                aria-describedby="biometric-storage-description"
              />
              <span>Enable {bioLabel} on this device</span>
            </label>
            <p id="biometric-storage-description">
              Save your passphrase in this device’s secure storage, protected by your enrolled
              biometrics.
            </p>
            {unlockNeedsEnrollment && (
              <p>
                Sign in with your passphrase and enable {bioLabel} to unlock after your session
                expires.
              </p>
            )}
          </div>
        )}
        <button type="submit" className="btn-primary" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Login'}
        </button>
        {biometricReady && (
          <button
            type="button"
            className="btn-biometric"
            onClick={handleBiometric}
            disabled={submitting}
          >
            Unlock with {bioLabel}
          </button>
        )}
        {submitting && <p role="status">Signing in…</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}
