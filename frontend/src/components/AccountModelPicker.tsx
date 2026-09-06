import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api-fetch';

export interface AccountSelection {
  accountId: string;
  model: string;
}
interface Account {
  id: string;
  label: string;
  models: { id: string; label: string }[];
}

export function AccountModelPicker({
  sessionId,
  preferredModel,
  onChange,
  disabled = false,
}: {
  disabled?: boolean;
  sessionId: string | null;
  preferredModel: string;
  onChange: (selection: AccountSelection | null) => void;
}) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selection, setSelection] = useState<AccountSelection | null>(null);
  const [bindingLabel, setBindingLabel] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    setError('');
    setBindingLabel('');
    setSelection(null);
    onChange(null);
    const url = sessionId ? `/api/sessions/${encodeURIComponent(sessionId)}/meta` : '/api/accounts';
    void apiFetch(url)
      .then(async (response) => {
        if (!response.ok) throw new Error('Account information unavailable. Reload to retry.');
        const data = await response.json();
        if (disposed) return;
        if (sessionId) {
          setBindingLabel(
            data.accountBinding
              ? `${data.accountBinding.accountLabel} · ${data.accountBinding.model}`
              : 'Existing task · legacy account',
          );
        } else {
          const catalog = data as Account[];
          if (!catalog.length) throw new Error('Configure an account on the Mac to start a task.');
          setAccounts(catalog);
          const first = catalog[0];
          const next = {
            accountId: first.id,
            model: first.models.some((m) => m.id === preferredModel)
              ? preferredModel
              : first.models[0].id,
          };
          setSelection(next);
          onChange(next);
        }
      })
      .catch((err: unknown) => {
        if (!disposed)
          setError(err instanceof Error ? err.message : 'Account information unavailable.');
      });
    return () => {
      disposed = true;
    };
    // Preferred model is read only when a new task opens; changing it must not reload the catalog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, onChange]);
  if (error) return <span role="alert">{error}</span>;
  if (sessionId)
    return <span className="chat-account-binding">{bindingLabel || 'Loading account…'}</span>;
  if (!selection) return <span>Loading accounts…</span>;
  const account = accounts.find((a) => a.id === selection.accountId)!;
  return (
    <>
      <select
        disabled={disabled}
        aria-label="Account"
        className="chat-model-select"
        value={account.id}
        onChange={(e) => {
          const nextAccount = accounts.find((a) => a.id === e.target.value)!;
          const next = { accountId: nextAccount.id, model: nextAccount.models[0].id };
          setSelection(next);
          onChange(next);
        }}
      >
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.label}
          </option>
        ))}
      </select>
      <select
        disabled={disabled}
        aria-label="Model"
        className="chat-model-select"
        value={selection.model}
        onChange={(e) => {
          const next = { ...selection, model: e.target.value };
          setSelection(next);
          onChange(next);
        }}
      >
        {account.models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
    </>
  );
}
