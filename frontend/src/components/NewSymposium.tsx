import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AccountModelPicker, type AccountSelection } from './AccountModelPicker';
import { SymposiumProfilePicker, type SymposiumProfileSelection } from './SymposiumProfilePicker';
import { apiFetch } from '../lib/api-fetch';

/** Creates a durable draft only; model execution starts through the existing director gates. */
export function NewSymposium() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('Symposium');
  const [role, setRole] = useState<'coder' | 'reviewer'>('coder');
  const [account, setAccount] = useState<AccountSelection | null>(null);
  const [profile, setProfile] = useState<SymposiumProfileSelection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const retry = useRef<{ payload: string; key: string } | null>(null);
  async function create() {
    if (busy || !account?.accountId || !profile || !title.trim()) return;
    const payload = JSON.stringify({
      title: title.trim(),
      ...account,
      role,
      profileSelection: profile,
    });
    if (retry.current?.payload !== payload) retry.current = { payload, key: crypto.randomUUID() };
    setBusy(true);
    setError('');
    try {
      const response = await apiFetch('/api/symposium/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...JSON.parse(payload), idempotencyKey: retry.current.key }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not create Symposium');
      if (typeof result.sessionId !== 'string' || !result.sessionId)
        throw new Error('Created session identity is unavailable');
      navigate(`/chat/${encodeURIComponent(result.sessionId)}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create Symposium');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="symposium-director" aria-label="New Symposium">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        New Symposium
      </button>
      {open && (
        <div className="symposium-director-panel">
          <p>
            Create a draft without sending a prompt. Choose its first seat, then review and activate
            it in Director controls.
          </p>
          <label>
            Symposium title
            <input
              value={title}
              maxLength={160}
              disabled={busy}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label>
            First seat role
            <select
              value={role}
              disabled={busy}
              onChange={(event) => setRole(event.target.value as 'coder' | 'reviewer')}
            >
              <option value="coder">Coder</option>
              <option value="reviewer">Reviewer</option>
            </select>
          </label>
          <AccountModelPicker
            scope="symposium"
            sessionId={null}
            preferredModel=""
            onChange={setAccount}
            disabled={busy}
          />
          <p>Select a saved profile with the same role. You can create or import one below.</p>
          <SymposiumProfilePicker value={profile} onChange={setProfile} disabled={busy} />
          {error && <p role="alert">{error}</p>}
          <button
            type="button"
            disabled={busy || !account?.accountId || !profile || !title.trim()}
            onClick={() => void create()}
          >
            {busy ? 'Creating Symposium…' : 'Create Symposium draft'}
          </button>
        </div>
      )}
    </section>
  );
}
