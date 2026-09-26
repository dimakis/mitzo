import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { apiFetch } from '../lib/api-fetch';
import { SymposiumDeviceLogin } from './SymposiumDeviceLogin';
import { SymposiumSubscriptionLogin } from './SymposiumSubscriptionLogin';
const rowSchema = z.object({
  id: z.string(),
  label: z.string(),
  revision: z.number().int().positive(),
  state: z.string(),
});
type Selection = z.infer<typeof rowSchema>;
/** Minimal admission UI: a displayed revision is selected by the operator, never inferred. */
export function SymposiumPersonalLogin({
  disabled = false,
  onAccountsChanged,
  callback = false,
}: {
  disabled?: boolean;
  onAccountsChanged?(): void;
  callback?: boolean;
}) {
  const [rows, setRows] = useState<Selection[]>([]);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try {
      const response = await apiFetch('/api/symposium/personal/connections');
      if (!response.ok) throw new Error();
      const next = z
        .object({ connections: z.array(rowSchema) })
        .parse(await response.json()).connections;
      setRows(next);
      setSelected((current) =>
        current && next.some((row) => row.id === current.id && row.revision === current.revision)
          ? current
          : null,
      );
      setError('');
    } catch {
      setError('Saved account selection is unavailable. Refresh before signing in.');
      setSelected(null);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const changed = () => {
    void refresh();
    onAccountsChanged?.();
  };
  return (
    <section aria-label="Personal sign-in selection">
      <label>
        Saved account for sign-in
        <select
          disabled={disabled || !!error}
          value={selected?.id ?? ''}
          onChange={(event) =>
            setSelected(rows.find((row) => row.id === event.target.value) ?? null)
          }
        >
          <option value="">Choose a saved account</option>
          {rows.map((row) => (
            <option
              key={row.id}
              value={row.id}
              disabled={
                !['connected', 'disconnected', 'reauth_required', 'connecting'].includes(row.state)
              }
            >
              {row.label} (revision {row.revision})
            </option>
          ))}
        </select>
      </label>
      {error && <p role="alert">{error}</p>}
      <button disabled={disabled} type="button" onClick={() => void refresh()}>
        Refresh saved accounts
      </button>
      {selected && (
        <div key={`${selected.id}:${selected.revision}`}>
          <p>
            Signing in replaces the selected connection. Existing seats require an explicit rebind.
          </p>
          <SymposiumDeviceLogin
            disabled={disabled}
            connectionId={selected.id}
            expectedRevision={selected.revision}
            onAccountsChanged={changed}
          />
          {callback && (
            <details>
              <summary>Browser callback alternative</summary>
              <SymposiumSubscriptionLogin
                disabled={disabled}
                connectionId={selected.id}
                expectedRevision={selected.revision}
                onComplete={changed}
                onCatalogRefresh={changed}
              />
            </details>
          )}
        </div>
      )}
    </section>
  );
}
