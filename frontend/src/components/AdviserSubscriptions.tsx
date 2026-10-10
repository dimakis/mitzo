import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { apiFetch } from '../lib/api-fetch';
import { HomeDialog } from './HomeDialog';
import '../styles/adviser-accounts.css';
const endpoint = '/api/terminals/subscriptions';
const accountSchema = z.object({
  id: z.string(),
  label: z.string(),
  email: z.string(),
  state: z.enum(['connected', 'disconnected', 'reauth_required']),
  revocationPending: z.boolean().default(false),
});
const attemptSchema = z.object({
  id: z.string(),
  state: z.enum(['pending', 'connected', 'failed', 'cancelled']),
});
const snapshotSchema = z.object({
  enabled: z.boolean(),
  accounts: z.array(accountSchema),
  pendingAttempt: attemptSchema
    .extend({ state: z.literal('pending') })
    .nullable()
    .optional(),
});
const labels = {
  connected: 'Connected',
  disconnected: 'Disconnected',
  reauth_required: 'Sign in required',
};
export function AdviserSubscriptions({
  disabled = false,
  onAccountsChanged,
}: {
  disabled?: boolean;
  onAccountsChanged(): void;
}) {
  const [snapshot, setSnapshot] = useState<z.infer<typeof snapshotSchema> | null>(null);
  const [open, setOpen] = useState(false),
    [label, setLabel] = useState('Personal ChatGPT');
  const [attempt, setAttempt] = useState<z.infer<typeof attemptSchema> | null>(null);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState('');
  const mounted = useRef(false),
    version = useRef(0),
    changed = useRef(onAccountsChanged);
  const mutation = useRef(false);
  changed.current = onAccountsChanged;
  const refresh = useCallback(async () => {
    const request = ++version.current;
    const response = await apiFetch(endpoint);
    if (!response.ok) throw Error('Unavailable');
    const data = snapshotSchema.parse(await response.json());
    if (mounted.current && request === version.current) {
      setSnapshot(data);
      // An older host can omit this field; omission is not proof that a known
      // attempt ended. Current hosts explicitly return null when none is pending.
      if (data.pendingAttempt !== undefined) setAttempt(data.pendingAttempt);
      setError('');
      if (data.pendingAttempt) setMessage('Finish sign-in in the browser on your Mac.');
      return { data, request };
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh().catch(() => {});
    return () => {
      mounted.current = false;
      // eslint-disable-next-line react-hooks/exhaustive-deps -- Invalidate asynchronous request generations, not a DOM ref.
      version.current++;
    };
  }, [refresh]);
  useEffect(() => {
    if (attempt?.state !== 'pending') return;
    let disposed = false,
      timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const response = await apiFetch(`${endpoint}/attempts/${encodeURIComponent(attempt.id)}`, {
          signal: controller.signal,
        });
        if (!response.ok) throw Error('Unavailable');
        const result = attemptSchema.parse(await response.json());
        if (result.id !== attempt.id) throw Error('Sign-in attempt changed');
        if (disposed) return;
        if (result.state !== 'pending') {
          const refreshed = await refresh();
          if (!disposed && refreshed && refreshed.request === version.current) {
            changed.current();
            // The host snapshot can recover a newer attempt from another tab.
            // Keep its controls and status rather than replaying this older result.
            if (refreshed.data.pendingAttempt) return;
            setAttempt(result);
            setMessage(
              result.state === 'connected'
                ? 'ChatGPT adviser connected. Choose its account and model.'
                : 'Sign-in did not complete. Retry when ready.',
            );
          }
          return;
        }
      } catch {
        if (!disposed) setError('Could not check sign-in. Refresh accounts or cancel sign-in.');
      }
      if (!disposed) timer = setTimeout(() => void poll(), 2000);
    };
    timer = setTimeout(() => void poll(), 2000);
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [attempt, refresh]);
  async function mutate(operation: () => Promise<void>) {
    if (mutation.current || disabled) return;
    mutation.current = true;
    version.current++;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await operation();
    } catch {
      if (mounted.current)
        setError('Account change could not be confirmed. Refresh accounts before retrying.');
    } finally {
      mutation.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function start(account?: z.infer<typeof accountSchema>) {
    await mutate(async () => {
      const response = await apiFetch(`${endpoint}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: account?.label ?? label,
          ...(account ? { accountId: account.id } : {}),
        }),
      });
      if (!response.ok) throw Error('Unavailable');
      const next = attemptSchema.parse(await response.json());
      if (mounted.current) {
        setAttempt(next);
        setMessage('Finish sign-in in the browser on your Mac.');
      }
    });
  }
  if (!snapshot?.enabled) return null;
  const pending = attempt?.state === 'pending',
    blocked = busy || disabled || pending;
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        className="home-secondary"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        Manage adviser accounts
      </button>
      {open && (
        <HomeDialog title="Adviser accounts" onClose={() => setOpen(false)}>
          <div className="adviser-account-manager">
            <p>
              Connect a ChatGPT account for advice and command suggestions. Complete sign-in on your
              Mac, then choose the account, model and thinking mode here.
            </p>
            {snapshot.accounts.map((account) => (
              <section key={account.id} className="adviser-account-row" aria-label={account.label}>
                <div>
                  <strong>{account.label}</strong>
                  <p className="workspace-muted">
                    {account.email} · {labels[account.state]}
                  </p>
                  {account.revocationPending && (
                    <p style={{ color: 'var(--color-warning)' }}>
                      Remote sign-out was not confirmed; disconnect Mitzo in ChatGPT Settings.
                    </p>
                  )}
                </div>
                <div className="adviser-account-actions">
                  <button
                    type="button"
                    className="home-secondary"
                    disabled={blocked}
                    aria-label={`Sign in again to ${account.label}`}
                    onClick={() => void start(account)}
                  >
                    Sign in again
                  </button>
                  {account.state !== 'disconnected' && (
                    <button
                      type="button"
                      className="home-secondary"
                      disabled={blocked}
                      aria-label={`Disconnect ${account.label}`}
                      onClick={() =>
                        void mutate(async () => {
                          const response = await apiFetch(
                            `${endpoint}/${encodeURIComponent(account.id)}/disconnect`,
                            {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: '{}',
                            },
                          );
                          if (!response.ok) throw Error('Unavailable');
                          const result = z
                            .object({ revoked: z.boolean() })
                            .parse(await response.json());
                          await refresh();
                          if (mounted.current) {
                            changed.current();
                            setMessage(
                              result.revoked
                                ? 'Adviser disconnected.'
                                : 'Adviser disconnected locally.',
                            );
                          }
                        })
                      }
                    >
                      Disconnect
                    </button>
                  )}
                </div>
              </section>
            ))}
            <form
              className="adviser-account-form"
              onSubmit={(event) => {
                event.preventDefault();
                void start();
              }}
            >
              <label>
                Account label
                <input
                  maxLength={80}
                  value={label}
                  disabled={blocked}
                  onChange={(event) => setLabel(event.target.value)}
                />
              </label>
              <button type="submit" className="home-secondary" disabled={blocked || !label.trim()}>
                Continue with ChatGPT on your Mac
              </button>
            </form>
            {pending && (
              <button
                type="button"
                className="home-secondary"
                disabled={busy || disabled}
                onClick={() =>
                  void mutate(async () => {
                    const response = await apiFetch(
                      `${endpoint}/attempts/${encodeURIComponent(attempt!.id)}/cancel`,
                      {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: '{}',
                      },
                    );
                    if (!response.ok) throw Error('Unavailable');
                    if (mounted.current) {
                      setAttempt(null);
                      setMessage('Sign-in cancelled.');
                    }
                  })
                }
              >
                Cancel sign-in
              </button>
            )}
            {message && <p role="status">{message}</p>}
            {error && <p role="alert">{error}</p>}
            <button
              type="button"
              className="home-secondary"
              disabled={busy || disabled}
              onClick={() =>
                void mutate(async () => {
                  await refresh();
                  if (mounted.current) changed.current();
                })
              }
            >
              Refresh adviser accounts
            </button>
          </div>
        </HomeDialog>
      )}
    </>
  );
}
