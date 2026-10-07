import { useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AccountModelPicker, type AccountSelection } from './AccountModelPicker';
import { SymposiumProfilePicker, type SymposiumProfileSelection } from './SymposiumProfilePicker';
import { apiFetch } from '../lib/api-fetch';
import './NewSymposium.css';

/** Creates a durable draft only; model execution starts through the existing director gates. */
export function NewSymposium() {
  const navigate = useNavigate();
  const headingId = useId();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('Symposium');
  const [role, setRole] = useState<'coder' | 'reviewer'>('coder');
  const [account, setAccount] = useState<AccountSelection | null>(null);
  const pickerEpoch = useRef(0);
  const [pickerGeneration, setPickerGeneration] = useState(0);
  const [profile, setProfile] = useState<{
    selection: SymposiumProfileSelection;
    role: 'coder' | 'reviewer';
    generation: number;
  } | null>(null);
  const profileSelection =
    profile?.role === role && profile.generation === pickerGeneration ? profile.selection : null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<string | null>(null);
  const retry = useRef<{ payload: string; key: string } | null>(null);
  async function create() {
    if (
      busy ||
      !account?.accountId ||
      !profileSelection ||
      profile?.generation !== pickerEpoch.current ||
      !title.trim()
    )
      return;
    const payload = JSON.stringify({
      title: title.trim(),
      ...account,
      role,
      profileSelection,
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
      if (result.artifacts && result.artifacts.state !== 'ready') setDraft(result.sessionId);
      else navigate(`/chat/${encodeURIComponent(result.sessionId)}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create Symposium');
    } finally {
      setBusy(false);
    }
  }
  async function retryArtifacts() {
    if (!draft || busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await apiFetch(
        `/api/symposium/sessions/${encodeURIComponent(draft)}/artifacts`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      );
      const result = await response.json();
      if (!response.ok || result.state !== 'ready')
        throw new Error('Shared files are still unavailable. Your draft is saved.');
      navigate(`/chat/${encodeURIComponent(draft)}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not prepare shared files');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="symposium-director symposium-new" aria-label="New Symposium">
      <button
        className="symposium-new-toggle"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span>New Symposium</span>
        <span aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div className="symposium-director-panel symposium-new-panel">
          {draft ? (
            <section className="symposium-new-card symposium-new-recovery" aria-label="Saved draft">
              <h3>Your draft is saved</h3>
              <p role="status">Draft created. Shared files are not ready yet.</p>
              {error && <p role="alert">{error}</p>}
              <button type="button" disabled={busy} onClick={() => void retryArtifacts()}>
                Retry shared files
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => navigate(`/chat/${encodeURIComponent(draft)}`)}
              >
                Open draft
              </button>
            </section>
          ) : (
            <>
              <header className="symposium-new-heading">
                <h3>Start with one agent</h3>
                <p>
                  Choose its account, role and profile. Add a reviewer and approve access in Review
                  team & approvals before work starts.
                </p>
              </header>
              <section className="symposium-new-card" aria-labelledby={`${headingId}-conversation`}>
                <h3 id={`${headingId}-conversation`}>Conversation</h3>
                <div className="symposium-new-fields">
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
                      onChange={(event) => {
                        pickerEpoch.current += 1;
                        setPickerGeneration(pickerEpoch.current);
                        setRole(event.target.value as 'coder' | 'reviewer');
                        setProfile(null);
                      }}
                    >
                      <option value="coder">Coder</option>
                      <option value="reviewer">Reviewer</option>
                    </select>
                  </label>
                </div>
              </section>
              <section className="symposium-new-card" aria-labelledby={`${headingId}-account`}>
                <h3 id={`${headingId}-account`}>Account & model</h3>
                <p className="symposium-new-hint">
                  Choose the provider account this agent will use.
                </p>
                <AccountModelPicker
                  scope="symposium"
                  sessionId={null}
                  preferredModel=""
                  onChange={setAccount}
                  disabled={busy}
                />
              </section>
              <section className="symposium-new-card" aria-labelledby={`${headingId}-profile`}>
                <h3 id={`${headingId}-profile`}>Agent profile</h3>
                <p className="symposium-new-hint">
                  Saved guidance for the {role === 'coder' ? 'coder' : 'reviewer'} role. Create or
                  import a profile in Manage profiles.
                </p>
                <SymposiumProfilePicker
                  key={`${role}:${pickerGeneration}`}
                  value={profileSelection}
                  onChange={(selection) => {
                    // A retired save/import may finish after a role change, including
                    // a round trip to the same role. Only this picker can select.
                    if (pickerGeneration !== pickerEpoch.current) return;
                    setProfile(
                      selection ? { selection, role, generation: pickerGeneration } : null,
                    );
                  }}
                  disabled={busy}
                  requiredRole={role}
                  compact
                />
              </section>
              <div className="symposium-new-actions">
                {error && <p role="alert">{error}</p>}
                <button
                  className="btn-primary"
                  type="button"
                  disabled={busy || !account?.accountId || !profileSelection || !title.trim()}
                  onClick={() => void create()}
                >
                  {busy ? 'Creating Symposium…' : 'Create Symposium draft'}
                </button>
                <p className="symposium-new-hint">Creates a draft without sending a prompt.</p>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
