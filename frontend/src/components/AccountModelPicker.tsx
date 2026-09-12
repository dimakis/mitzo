import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { apiFetch } from '../lib/api-fetch';

export interface AccountSelection {
  accountId?: string;
  model: string;
  reasoningEffort?: string | null;
}
interface Account {
  id: string;
  label: string;
  modelDiscovery?: { stale: boolean };
  models: {
    id: string;
    label: string;
    reasoningEfforts?: string[];
    defaultReasoningEffort?: string;
  }[];
}
const modelsSchema = z
  .array(
    z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      reasoningEfforts: z.array(z.string()).optional(),
      defaultReasoningEffort: z.string().optional(),
    }),
  )
  .min(1);
const catalogSchema = z.array(
  z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    modelDiscovery: z.object({ stale: z.boolean() }).optional(),
    models: modelsSchema,
  }),
);

function withThinking(selection: AccountSelection, account: Account): AccountSelection {
  const model = account.models.find((m) => m.id === selection.model);
  if (selection.reasoningEffort === null) return selection;
  const effort = model?.reasoningEfforts?.includes(selection.reasoningEffort ?? '')
    ? selection.reasoningEffort
    : model?.defaultReasoningEffort;
  return {
    accountId: selection.accountId,
    model: selection.model,
    ...(effort && model?.reasoningEfforts?.includes(effort) ? { reasoningEffort: effort } : {}),
  };
}

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
  const selectionRef = useRef(selection);
  if (selection) selectionRef.current = selection;
  const [bindingLabel, setBindingLabel] = useState('');
  const [editingAlias, setEditingAlias] = useState(false);
  const [alias, setAlias] = useState('');
  const [aliasError, setAliasError] = useState('');
  const [savingAlias, setSavingAlias] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [legacy, setLegacy] = useState(false);
  const [fixedSession, setFixedSession] = useState(false);
  const [empty, setEmpty] = useState(false);
  const callbacks = useRef({ onChange, onUnavailable });
  callbacks.current = { onChange, onUnavailable };
  useEffect(() => {
    if (error || empty) onUnavailable?.();
  }, [error, empty, onUnavailable]);
  useEffect(() => {
    let disposed = false;
    setError('');
    setEditingAlias(false);
    setBindingLabel('');
    setFixedSession(false);
    setSelection(null);
    setEmpty(false);
    callbacks.current.onChange(null);
    const baseUrl = sessionId
      ? `/api/sessions/${encodeURIComponent(sessionId)}/meta`
      : legacy
        ? '/api/models'
        : '/api/accounts';
    const url = baseUrl + (attempt ? '?refresh=1' : '');
    const controller = new AbortController();
    async function fetchMetadata() {
      const retryDelays = [100, 200, 400];
      for (let retry = 0; ; retry++) {
        const response = await apiFetch(url, { signal: controller.signal });
        if (!sessionId || response.status !== 404 || retry >= retryDelays.length || disposed)
          return response;
        // Accepted sessions can arrive before provider startup persists their metadata.
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            controller.signal.removeEventListener('abort', finish);
            resolve();
          };
          const timer = setTimeout(finish, retryDelays[retry]);
          controller.signal.addEventListener('abort', finish, { once: true });
        });
        if (disposed) return response;
      }
    }
    void fetchMetadata()
      .then(async (response) => {
        if (sessionId && response.status === 404) {
          if (!disposed) {
            setBindingLabel('Existing task · legacy account');
            setFixedSession(true);
            callbacks.current.onChange({ model: preferredModel });
          }
          return;
        }
        if (!response.ok) throw new Error('Account information unavailable. Retry to continue.');
        const data = await response.json();
        if (disposed) return;
        if (sessionId) {
          const modelSelection = z
            .object({
              model: z.string(),
              models: modelsSchema,
              reasoningEffort: z.string().nullable().optional(),
            })
            .safeParse(data.modelSelection);
          if (data.accountBinding && modelSelection.success) {
            const account = {
              id: data.accountBinding.accountId,
              label: data.accountBinding.accountLabel,
              models: modelSelection.data.models,
            };
            setAccounts([account]);
            const next = withThinking(
              {
                accountId: account.id,
                model: modelSelection.data.model,
                reasoningEffort: modelSelection.data.reasoningEffort,
              },
              account,
            );
            setSelection(next);
            callbacks.current.onChange(next);
          } else {
            const next = data.accountBinding
              ? { accountId: data.accountBinding.accountId, model: data.accountBinding.model }
              : { model: preferredModel };
            setFixedSession(true);
            callbacks.current.onChange(next);
          }
          setBindingLabel(
            data.accountBinding
              ? `${data.accountBinding.accountLabel} · ${data.accountBinding.model}`
              : 'Existing task · legacy account',
          );
        } else {
          const parsed = legacy
            ? modelsSchema
                .transform((models) => [{ id: '', label: 'Legacy server account', models }])
                .safeParse(data)
            : catalogSchema.safeParse(data);
          if (!parsed.success)
            throw new Error(
              'Invalid account information. Retry or check the server configuration.',
            );
          const catalog: Account[] = parsed.data;
          if (!catalog.length) {
            setEmpty(true);
            return;
          }
          setAccounts(catalog);
          const previous = attempt ? selectionRef.current : null;
          const first = catalog.find((a) => a.id === previous?.accountId) ?? catalog[0];
          const next = {
            ...(!legacy ? { accountId: first.id } : {}),
            model: first.models.some((m) => m.id === (previous?.model ?? preferredModel))
              ? (previous?.model ?? preferredModel)
              : first.models[0].id,
          };
          const selected = withThinking(
            { ...next, reasoningEffort: previous?.reasoningEffort },
            first,
          );
          setSelection(selected);
          callbacks.current.onChange(selected);
        }
      })
      .catch((err: unknown) => {
        if (!disposed) {
          setError(err instanceof Error ? err.message : 'Account information unavailable.');
        }
      });
    return () => {
      disposed = true;
      controller.abort();
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
        {!sessionId && !legacy && (
          <button disabled={disabled} onClick={() => setLegacy(true)}>
            Use legacy server account
          </button>
        )}
      </>
    );
  if (sessionId && fixedSession)
    return <span className="chat-account-binding">{bindingLabel}</span>;
  if (sessionId && !selection)
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
  const account = accounts.find((a) => a.id === (selection.accountId ?? ''));
  if (!account) return <span role="alert">Selected account is unavailable. Reopen the task.</span>;
  return (
    <>
      {sessionId ? (
        <span className="chat-account-binding">{account.label}</span>
      ) : legacy ? (
        <span>Legacy server account</span>
      ) : (
        <select
          disabled={disabled}
          aria-label="Account"
          className="chat-model-select"
          value={account.id}
          onChange={(e) => {
            setEditingAlias(false);
            const nextAccount = accounts.find((a) => a.id === e.target.value)!;
            const next = withThinking(
              { accountId: nextAccount.id, model: nextAccount.models[0].id },
              nextAccount,
            );
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
      {!legacy && (
        <button
          disabled={disabled}
          aria-label="Edit account alias"
          onClick={() => {
            setAlias(account.label);
            setAliasError('');
            setEditingAlias(true);
          }}
        >
          Rename
        </button>
      )}
      {editingAlias && (
        <form
          className="chat-account-alias-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setSavingAlias(true);
            setAliasError('');
            try {
              const response = await apiFetch(
                `/api/accounts/${encodeURIComponent(account.id)}/alias`,
                {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ alias }),
                },
              );
              if (!response.ok) throw new Error('Could not save alias. Retry.');
              const data = z.object({ label: z.string() }).parse(await response.json());
              setAccounts((old) =>
                old.map((a) => (a.id === account.id ? { ...a, label: data.label } : a)),
              );
              setEditingAlias(false);
            } catch {
              setAliasError('Could not save alias. Retry.');
            } finally {
              setSavingAlias(false);
            }
          }}
        >
          <input
            aria-label="Account alias"
            maxLength={80}
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            disabled={savingAlias}
          />
          <button disabled={savingAlias || disabled} type="submit">
            Save alias
          </button>
          <button type="button" disabled={savingAlias} onClick={() => setEditingAlias(false)}>
            Cancel
          </button>
          {aliasError && <span role="alert">{aliasError}</span>}
        </form>
      )}
      <select
        disabled={disabled}
        aria-label="Model"
        className="chat-model-select"
        value={selection.model}
        onChange={(e) => {
          const next = withThinking(
            { accountId: selection.accountId, model: e.target.value },
            account,
          );
          setSelection(next);
          onChange(next);
        }}
      >
        {!account.models.some((m) => m.id === selection.model) && (
          <option value={selection.model} disabled>
            {selection.model} (unavailable)
          </option>
        )}
        {account.models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
      {!!account.models.find((m) => m.id === selection.model)?.reasoningEfforts?.length && (
        <select
          aria-label="Thinking"
          className="chat-model-select"
          disabled={disabled}
          value={selection.reasoningEffort ?? ''}
          onChange={(e) => {
            const next = { ...selection };
            next.reasoningEffort = e.target.value || null;
            setSelection(next);
            onChange(next);
          }}
        >
          <option value="">Model default</option>
          {account.models
            .find((m) => m.id === selection.model)
            ?.reasoningEfforts?.map((effort) => (
              <option key={effort} value={effort}>
                Thinking: {effort}
              </option>
            ))}
        </select>
      )}
      {account.modelDiscovery?.stale && (
        <span role="status">Model refresh failed. Showing the last available list.</span>
      )}
      {!legacy && (
        <button disabled={disabled} onClick={() => setAttempt((n) => n + 1)}>
          Refresh models
        </button>
      )}
    </>
  );
}
