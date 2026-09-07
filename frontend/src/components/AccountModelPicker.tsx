import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { apiFetch } from '../lib/api-fetch';

export interface AccountSelection {
  accountId?: string;
  model: string;
}
interface Account {
  id: string;
  label: string;
  models: { id: string; label: string }[];
}
const modelsSchema = z.array(z.object({ id: z.string().min(1), label: z.string().min(1) })).min(1);
const catalogSchema = z.array(
  z.object({ id: z.string().min(1), label: z.string().min(1), models: modelsSchema }),
);

export function AccountModelPicker({
  sessionId,
  preferredModel,
  onChange,
  onUnavailable,
  disabled = false,
}: {
  disabled?: boolean;
  sessionId: string | null;
  preferredModel: string;
  onChange: (selection: AccountSelection | null) => void;
  onUnavailable?: () => void;
}) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selection, setSelection] = useState<AccountSelection | null>(null);
  const [bindingLabel, setBindingLabel] = useState('');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [legacy, setLegacy] = useState(false);
  const [empty, setEmpty] = useState(false);
  const callbacks = useRef({ onChange, onUnavailable });
  callbacks.current = { onChange, onUnavailable };
  useEffect(() => {
    let disposed = false;
    setError('');
    setBindingLabel('');
    setSelection(null);
    setEmpty(false);
    callbacks.current.onChange(null);
    const url = sessionId
      ? `/api/sessions/${encodeURIComponent(sessionId)}/meta`
      : legacy
        ? '/api/models'
        : '/api/accounts';
    void apiFetch(url)
      .then(async (response) => {
        if (!response.ok) throw new Error('Account information unavailable. Retry to continue.');
        const data = await response.json();
        if (disposed) return;
        if (sessionId) {
          setBindingLabel(
            data.accountBinding
              ? `${data.accountBinding.accountLabel} · ${data.accountBinding.model}`
              : 'Existing task · legacy account',
          );
        } else {
          const parsed = legacy ? modelsSchema.safeParse(data) : catalogSchema.safeParse(data);
          if (!parsed.success)
            throw new Error(
              'Invalid account information. Retry or check the server configuration.',
            );
          const catalog: Account[] = legacy
            ? [{ id: '', label: 'Legacy server account', models: modelsSchema.parse(data) }]
            : catalogSchema.parse(data);
          if (!catalog.length) {
            setEmpty(true);
            callbacks.current.onUnavailable?.();
            return;
          }
          setAccounts(catalog);
          const first = catalog[0];
          const next = {
            ...(!legacy ? { accountId: first.id } : {}),
            model: first.models.some((m) => m.id === preferredModel)
              ? preferredModel
              : first.models[0].id,
          };
          setSelection(next);
          callbacks.current.onChange(next);
        }
      })
      .catch((err: unknown) => {
        if (!disposed) {
          setError(err instanceof Error ? err.message : 'Account information unavailable.');
          callbacks.current.onUnavailable?.();
        }
      });
    return () => {
      disposed = true;
    };
    // Preferred model is read only when a new task opens; changing it must not reload the catalog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, attempt, legacy]);
  if (error)
    return (
      <>
        <span role="alert">{error}</span>
        <button disabled={disabled} onClick={() => setAttempt((value) => value + 1)}>
          Retry accounts
        </button>
      </>
    );
  if (sessionId)
    return <span className="chat-account-binding">{bindingLabel || 'Loading account…'}</span>;
  if (empty)
    return (
      <>
        <span>No account profiles configured.</span>
        <button disabled={disabled} onClick={() => setLegacy(true)}>
          Use legacy server account
        </button>
      </>
    );
  if (!selection) return <span>Loading accounts…</span>;
  const account = accounts.find((a) => a.id === (selection.accountId ?? ''))!;
  return (
    <>
      {legacy ? (
        <span>Legacy server account</span>
      ) : (
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
      )}
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
