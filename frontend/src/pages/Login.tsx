import { useState, useEffect, useRef, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  apiFetch,
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
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = loginReturnPath(new URLSearchParams(location.search).get('returnTo'));

  useEffect(() => {
    const onAuthRestored = (event: Event) => {
      if (isCrossTabAuthEvent(event)) navigate(returnTo, { replace: true });
    };
    window.addEventListener(AUTH_RESTORED_EVENT, onAuthRestored);
    return () => window.removeEventListener(AUTH_RESTORED_EVENT, onAuthRestored);
  }, [navigate, returnTo]);

  useEffect(() => {
    isBiometricAvailable().then((available) => {
      setBiometricReady(available);
      if (available && !biometricAttempted.current) {
        biometricAttempted.current = true;
        getBiometricLabel().then(setBioLabel);
        biometricLogin(getApiBaseUrl()).then((token) => {
          if (token) {
            notifySuccess();
            navigate(returnTo, { replace: true });
          } else setUnlockNeedsEnrollment(true);
        });
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleBiometric() {
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
    setSubmitting(true);

    markAuthLost();
    try {
      const res = await apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passphrase }),
      });

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
      setSubmitting(false);
    }
  }

  return (
    <div className="login-page">
      <form onSubmit={handleSubmit} className="login-form">
        <MitzoBrand className="login-brand" />
        <h1 className="sr-only">Sign in to Mitzo</h1>
        <input
          type="password"
          placeholder="Passphrase"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          autoFocus
        />
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
          <button type="button" className="btn-biometric" onClick={handleBiometric}>
            Unlock with {bioLabel}
          </button>
        )}
        {error && <p className="error">{error}</p>}
      </form>
    </div>
  );
}
