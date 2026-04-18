import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../lib/api-fetch';

export function Login() {
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState('');
  const navigate = useNavigate();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');

    // Clear any stale token before attempting login
    localStorage.removeItem('mitzo_auth_token');

    const res = await apiFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase }),
    });

    if (res.ok) {
      // Store JWT for Capacitor (non-cookie) auth. Browser ignores this.
      const data = await res.json().catch(() => ({}));
      if (data.token) {
        localStorage.setItem('mitzo_auth_token', data.token);
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
        {error && <p className="error">{error}</p>}
      </form>
    </div>
  );
}
