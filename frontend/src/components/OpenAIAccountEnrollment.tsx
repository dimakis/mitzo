import { useCallback, useEffect, useRef, useState } from 'react';
import { enrollOpenAIAccount, getOpenAIAccounts } from '../lib/connections-api';
import type { EnrolledOpenAIAccount } from '../types/connections';

export function OpenAIAccountEnrollment({
  csrf,
  authorized,
  expiresAt,
  onReauthorizationNeeded,
}: {
  csrf: string;
  authorized: boolean;
  expiresAt?: number;
  onReauthorizationNeeded: () => void;
}) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [accounts, setAccounts] = useState<EnrolledOpenAIAccount[]>([]);
  const [label, setLabel] = useState('');
  const [projectLabel, setProjectLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [billingConfirmed, setBillingConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reviewRequired, setReviewRequired] = useState(false);
  const [created, setCreated] = useState<EnrolledOpenAIAccount | null>(null);
  const [message, setMessage] = useState('');
  const mounted = useRef(false);
  const pending = useRef(false);
  const requestId = useRef<string | null>(null);
  const unresolved = accounts.some(
    (account) => account.state === 'connecting' || account.state === 'needs_attention',
  );
  const retrySafe =
    !unresolved &&
    accounts.some(
      (account) => account.requestId === requestId.current && account.state === 'failed',
    );
  const refresh = useCallback(async () => {
    try {
      const status = await getOpenAIAccounts();
      if (!mounted.current) return;
      setEnabled(status.enabled);
      setAccounts(status.accounts);
    } catch {
      if (!mounted.current) return;
      setEnabled(false);
      setMessage('Account status could not be loaded. Check again before adding an account.');
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);
  useEffect(() => {
    if (!authorized || enabled === false || unresolved) {
      setApiKey('');
      setBillingConfirmed(false);
    }
  }, [authorized, enabled, unresolved]);
  const submit = async () => {
    if (pending.current || reviewRequired || unresolved || created || !enabled) return;
    if (!authorized || (expiresAt !== undefined && expiresAt <= Date.now())) {
      setApiKey('');
      setBillingConfirmed(false);
      onReauthorizationNeeded();
      return;
    }
    if (!label.trim() || !projectLabel.trim() || !apiKey.trim() || !billingConfirmed) return;
    pending.current = true;
    setBusy(true);
    setMessage('');
    const oneShot = apiKey;
    setApiKey('');
    setBillingConfirmed(false);
    try {
      requestId.current ??= crypto.randomUUID();
      const account = await enrollOpenAIAccount({
        csrf,
        requestId: requestId.current,
        label: label.trim(),
        projectLabel: projectLabel.trim(),
        apiKey: oneShot,
        billingConfirmed: true,
      });
      if (!mounted.current) return;
      if (account.state === 'ready') setCreated(account);
      else {
        setReviewRequired(true);
        setMessage('Enrollment needs attention. Check account status before trying again.');
      }
    } catch {
      if (mounted.current) {
        setReviewRequired(true);
        setMessage('Could not confirm enrollment. Review account status before trying again.');
      }
    } finally {
      if (mounted.current) {
        await refresh();
        setBusy(false);
      }
      pending.current = false;
    }
  };
  return (
    <section
      className="connections-card openai-account-enrollment"
      aria-labelledby="openai-enrollment-heading"
    >
      <h2 id="openai-enrollment-heading">Add a new OpenAI API account</h2>
      <p>
        Existing tasks keep their current account. Select this new account when starting a new chat.
      </p>
      {message && <p role="alert">{message}</p>}
      {enabled === null ? (
        <p role="status">Loading account setup…</p>
      ) : !enabled ? (
        <p>Adding OpenAI API accounts is unavailable.</p>
      ) : created ? (
        <p role="status">{created.label} is ready for new chats.</p>
      ) : unresolved ? (
        <p role="status">
          A previous enrollment must be reviewed before adding another account. Check its status and
          ask the operator to reconcile the saved operation.
        </p>
      ) : reviewRequired ? (
        <h3>Review enrollment status</h3>
      ) : !authorized ? (
        <button className="workspace-primary" onClick={onReauthorizationNeeded}>
          Confirm identity to add an account
        </button>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="connections-field">
            Account label
            <input
              value={label}
              maxLength={80}
              disabled={busy}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          <label className="connections-field">
            Intended work project name
            <input
              value={projectLabel}
              maxLength={120}
              disabled={busy}
              onChange={(event) => setProjectLabel(event.target.value)}
            />
          </label>
          <p className="workspace-muted">
            This name records your intended use. It does not verify the key’s project identity.
          </p>
          <label className="connections-field">
            API key
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              maxLength={16384}
              value={apiKey}
              disabled={busy}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
          <p className="workspace-muted">
            Validation runs one brief gpt-6-luna request with low reasoning, billed to the newly
            entered key’s project.
          </p>
          <label className="connections-key-confirmation">
            <input
              type="checkbox"
              checked={billingConfirmed}
              disabled={busy}
              onChange={(event) => setBillingConfirmed(event.target.checked)}
            />
            <span>I authorize this validation charge to the project associated with this key.</span>
          </label>
          <button
            className="workspace-primary"
            disabled={
              busy || !label.trim() || !projectLabel.trim() || !apiKey.trim() || !billingConfirmed
            }
          >
            {busy ? 'Validating new account…' : 'Validate and add account'}
          </button>
        </form>
      )}
      {accounts.length > 0 && (
        <div aria-label="Enrolled OpenAI API accounts">
          <h3>Enrolled accounts</h3>
          {accounts.map((account) => (
            <p key={account.id}>
              {account.label} · {account.projectLabel} ·{' '}
              {account.state === 'ready'
                ? 'Ready'
                : account.state === 'connecting'
                  ? 'Connecting'
                  : account.state === 'failed'
                    ? 'Validation failed'
                    : 'Needs attention'}
            </p>
          ))}
        </div>
      )}
      {reviewRequired && retrySafe && (
        <button
          className="workspace-primary"
          disabled={busy}
          onClick={() => {
            requestId.current = null;
            setReviewRequired(false);
            setMessage(
              'Validation did not save an account. Enter a new key to start a new validation.',
            );
          }}
        >
          Try a new key
        </button>
      )}
      <button className="workspace-text-link" disabled={busy} onClick={() => void refresh()}>
        Check account status
      </button>
    </section>
  );
}
