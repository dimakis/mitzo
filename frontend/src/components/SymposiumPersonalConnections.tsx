import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { apiFetch } from '../lib/api-fetch';
import { SymposiumSubscriptionLogin } from './SymposiumSubscriptionLogin';
import { SymposiumDeviceLogin } from './SymposiumDeviceLogin';
import './SymposiumPersonalConnections.css';

const connectionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  revision: z.number().int().positive(),
  state: z.enum([
    'connected',
    'disconnected',
    'reauth_required',
    'connecting',
    'disconnecting',
    'recovery_required',
  ]),
  account: z.object({ email: z.string(), planType: z.string() }).optional(),
});
type Connection = z.infer<typeof connectionSchema>;
const endpoint = '/api/symposium/personal/connections';
const stateLabels: Record<Connection['state'], string> = {
  connected: 'Connected',
  disconnected: 'Disconnected',
  reauth_required: 'Sign in required',
  connecting: 'Sign-in pending',
  disconnecting: 'Disconnecting',
  recovery_required: 'Host recovery required',
};

export function SymposiumPersonalConnections({
  onAccountsChanged,
  disabled = false,
}: {
  disabled?: boolean;
  onAccountsChanged?(): void;
}) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [callbackId, setCallbackId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const version = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++version.current;
    try {
      const response = await apiFetch(endpoint);
      if (!response.ok) throw new Error('Unavailable');
      const body = z
        .object({ connections: z.array(connectionSchema) })
        .parse(await response.json());
      if (request !== version.current) return;
      setConnections(body.connections);
      setActiveId((current) =>
        current &&
        body.connections.some(
          (row) => row.id === current && ['connecting', 'disconnecting'].includes(row.state),
        )
          ? current
          : null,
      );
      setCallbackId((current) =>
        current && body.connections.some((row) => row.id === current && row.state === 'connecting')
          ? current
          : null,
      );
      setLoaded(true);
      setError('');
    } catch {
      if (request === version.current)
        setError('Could not load personal accounts. Refresh before changing a saved connection.');
    }
  }, []);
  useEffect(() => {
    void refresh();
    return () => {
      version.current += 1;
    };
  }, [refresh]);
  async function mutate(path: string, body: unknown, success: string) {
    if (disabled) return;
    setBusy(true);
    setMessage('');
    try {
      const response = await apiFetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error('Request failed');
      setMessage(success);
      if (path === endpoint) setLabel('');
      onAccountsChanged?.();
    } catch {
      setMessage(
        'Could not confirm the change. Check the refreshed account status before trying again.',
      );
    } finally {
      await refresh();
      setBusy(false);
    }
  }
  const pendingId =
    activeId ??
    connections.find((item) => item.state === 'connecting' || item.state === 'disconnecting')?.id;
  return (
    <section className="personal-connections" aria-label="Personal ChatGPT accounts">
      <h2>Personal ChatGPT accounts</h2>
      <p>
        Save separate accounts on this Mac, then explicitly choose an account and model for each
        reviewer. Reconnect changes only that saved connection; existing seats need an explicit
        rebind.
      </p>
      <p>
        Saved identities remain after Mitzo restarts. Accounts marked “Sign in required” need a
        fresh sign-in before use.
      </p>
      {error && (
        <>
          <p role="alert">{error}</p>
          <button type="button" disabled={disabled} onClick={() => void refresh()}>
            Retry personal accounts
          </button>
        </>
      )}
      {!loaded && !error && <p role="status">Loading personal accounts…</p>}
      {message && <p role="status">{message}</p>}
      {connections.map((connection) => (
        <section
          key={connection.id}
          className="personal-connection-card"
          aria-label={connection.label}
        >
          <div>
            <h3>{connection.label}</h3>
            <p>{connection.account?.email ?? 'No verified account yet'}</p>
            {connection.account && <span>{connection.account.planType}</span>}
            <p className="personal-connection-status">{stateLabels[connection.state]}</p>
          </div>
          {connection.state === 'recovery_required' ? (
            <p>
              This connection needs recovery on the Mac before it can be used. Cleanup may include
              other seats in the same owned workspace. Refresh after host recovery.
            </p>
          ) : connection.state === 'disconnecting' ? (
            <p>Wait for disconnect to finish, then refresh.</p>
          ) : (
            <SymposiumDeviceLogin
              connectionId={connection.id}
              expectedRevision={connection.revision}
              buttonLabel={
                connection.state === 'connected'
                  ? 'Reconnect'
                  : connection.state === 'connecting'
                    ? 'Continue sign-in'
                    : 'Connect'
              }
              disabled={
                disabled ||
                busy ||
                !!error ||
                callbackId === connection.id ||
                (!!pendingId && pendingId !== connection.id)
              }
              onPendingChange={(pending) => {
                setActiveId((current) =>
                  pending ? connection.id : current === connection.id ? null : current,
                );
                if (!pending) void refresh();
              }}
              onAccountsChanged={() => {
                void refresh();
                onAccountsChanged?.();
              }}
            />
          )}
          {!['recovery_required', 'disconnecting'].includes(connection.state) && (
            <details>
              <summary>Browser callback alternative for {connection.label}</summary>
              <SymposiumSubscriptionLogin
                connectionId={connection.id}
                expectedRevision={connection.revision}
                disabled={
                  disabled ||
                  busy ||
                  !!error ||
                  (!!pendingId && (pendingId !== connection.id || callbackId !== connection.id))
                }
                onPendingChange={(pending) => {
                  setCallbackId(pending ? connection.id : null);
                  setActiveId((current) =>
                    pending ? connection.id : current === connection.id ? null : current,
                  );
                }}
                onComplete={() => {
                  void refresh();
                  onAccountsChanged?.();
                }}
                onCatalogRefresh={() => void refresh()}
              />
            </details>
          )}
          {connection.state === 'connected' && (
            <button
              type="button"
              disabled={disabled || busy || !!error || !!pendingId}
              onClick={() =>
                void mutate(
                  `${endpoint}/${encodeURIComponent(connection.id)}/disconnect`,
                  { expectedRevision: connection.revision },
                  `Disconnected ${connection.label}. Other saved accounts are unchanged.`,
                )
              }
            >
              Disconnect
            </button>
          )}
        </section>
      ))}
      {loaded && connections.length === 0 && <p>No saved personal accounts yet.</p>}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (label.trim())
            void mutate(
              endpoint,
              { label: label.trim() },
              'Saved account added. Choose Connect when ready to sign in.',
            );
        }}
      >
        <label>
          Account label
          <input
            disabled={disabled}
            value={label}
            maxLength={120}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="For example, Personal or Research"
          />
        </label>
        <button disabled={disabled || !loaded || busy || !!error || !label.trim()} type="submit">
          Add personal account
        </button>
      </form>
      <button type="button" disabled={disabled || busy} onClick={() => void refresh()}>
        Refresh personal accounts
      </button>
      {pendingId && <p>Finish or cancel the pending sign-in before connecting another account.</p>}
    </section>
  );
}
