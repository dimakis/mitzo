import { useState, useEffect, useRef, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  apiFetch,
  AUTH_RESTORED_EVENT,
  getApiBaseUrl,
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
} from '../lib/biometric';
import { saveTokenToWatch } from '../lib/watch-auth';
import { notifySuccess } from '../lib/haptics';
import { MitzoBrand } from '../components/MitzoBrand';

export function Login() {
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [biometricReady, setBiometricReady] = useState(false);
  const biometricAttempted = useRef(false);
  const [bioLabel, setBioLabel] = useState('Biometric');
  const navigate = useNavigate();

  useEffect(() => {
    const onAuthRestored = (event: Event) => {
      if (isCrossTabAuthEvent(event)) navigate('/');
    };
    window.addEventListener(AUTH_RESTORED_EVENT, onAuthRestored);
    return () => window.removeEventListener(AUTH_RESTORED_EVENT, onAuthRestored);
  }, [navigate]);

  useEffect(() => {
    isBiometricAvailable().then((available) => {
      setBiometricReady(available);
      if (available && !biometricAttempted.current) {
        biometricAttempted.current = true;
        getBiometricLabel().then(setBioLabel);
        biometricLogin(getApiBaseUrl()).then((token) => {
          if (token) {
            notifySuccess();
            navigate('/');
          }
        });
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleBiometric() {
    const token = await biometricLogin(getApiBaseUrl());
    if (token) {
      notifySuccess();
      navigate('/');
    } else {
      setError('Biometric authentication failed — try passphrase');
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
          await saveCredentials(data.token);
          await saveTokenToWatch(data.token);
        } else loginSucceeded();
        navigate('/');
      } else {
        const restored = await restoreCookieAuthentication().catch(() => false);
        if (restored) {
          navigate('/');
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
