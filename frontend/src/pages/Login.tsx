import { useState, useEffect, useRef, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch, getApiBaseUrl } from '../lib/api-fetch';
import {
  isBiometricAvailable,
  getBiometricLabel,
  biometricLogin,
  saveCredentials,
} from '../lib/biometric';
import { saveTokenToWatch } from '../lib/watch-auth';
import { notifySuccess } from '../lib/haptics';

export function Login() {
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState('');
  const [biometricReady, setBiometricReady] = useState(false);
  const biometricAttempted = useRef(false);
  const [bioLabel, setBioLabel] = useState('Biometric');
  const navigate = useNavigate();

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

    localStorage.removeItem('mitzo_auth_token');
    const res = await apiFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase }),
    });

    if (res.ok) {
      const data = (await res.json()) as { token?: string };
      if (data.token) {
        localStorage.setItem('mitzo_auth_token', data.token);
        await saveCredentials(data.token);
        await saveTokenToWatch(data.token);
      }
      navigate('/');
    } else {
      setError('Invalid passphrase');
    }
  }

  return (
    <div className="login-page">
      <form onSubmit={handleSubmit} className="login-form">
        <h1>Mitzo</h1>
        <input
          type="password"
          placeholder="Passphrase"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          autoFocus
        />
        <button type="submit" className="btn-primary">
          Login
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
