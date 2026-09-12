import { useCallback, useEffect, useState } from 'react';
import {
  createConnection,
  getConnectionAudit,
  getConnections,
  reauthorize,
  revokeConnection,
  rotateConnection,
  testConnection,
  updateAssignments,
} from '../lib/connections-api';
import type {
  ConnectionAuditEntry,
  ConnectionsCatalog,
  ManagedConnection,
} from '../types/connections';

const endpoint = 'https://redhat.atlassian.net';
const time = (value: number | null) =>
  value ? new Date(value).toLocaleString() : 'Not yet verified';
const status = (connection: ManagedConnection) =>
  connection.errorCode
    ? `${connection.status.replaceAll('_', ' ')}: ${connection.errorCode}`
    : connection.status.replaceAll('_', ' ');

export function ConnectionsView() {
  const [data, setData] = useState<ConnectionsCatalog | null>(null);
  const [loadError, setLoadError] = useState('');
  const [message, setMessage] = useState('');
  const [csrf, setCsrf] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [label, setLabel] = useState('Jira');
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [audit, setAudit] = useState<Record<string, ConnectionAuditEntry[]>>({});
  const [rotateId, setRotateId] = useState<string | null>(null);
  const [rotationToken, setRotationToken] = useState('');
  const refresh = useCallback(async () => {
    setLoadError('');
    try {
      setData(await getConnections());
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Unable to load connections.');
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(
    () => () => {
      setToken('');
      setRotationToken('');
    },
    [],
  );
  const requireReauthorization = () => {
    if (csrf) return true;
    setMessage('Reauthorize with your passphrase before changing Jira access.');
    return false;
  };
  const run = async (name: string, action: () => Promise<unknown>, success: string) => {
    setBusy(name);
    setMessage('');
    try {
      await action();
      setMessage(success);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The request failed. Refresh and retry.');
      await refresh();
    } finally {
      setBusy(null);
    }
  };
  const toggle = (id: string, values = selected) =>
    setSelected(values.includes(id) ? values.filter((value) => value !== id) : [...values, id]);
  const loadAudit = async (id: string) => {
    setBusy(`audit:${id}`);
    try {
      const entries = await getConnectionAudit(id);
      setAudit((current) => ({ ...current, [id]: entries }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to load audit history.');
    } finally {
      setBusy(null);
    }
  };
  if (!data && !loadError)
    return (
      <main className="workspace-page">
        <h1>Connections</h1>
        <p>Loading connections…</p>
      </main>
    );
  if (!data)
    return (
      <main className="workspace-page">
        <h1>Connections</h1>
        <p role="alert">{loadError}</p>
        <button className="workspace-primary" onClick={() => void refresh()}>
          Retry
        </button>
      </main>
    );
  return (
    <main className="workspace-page connections-page">
      <h1>Connections</h1>
      <p className="workspace-muted">
        Assignments apply to {data.appliesTo}. Adding a connection never expands a retained
        conversation; removal and revocation reduce managed access immediately.
      </p>
      {message && (
        <p className="connections-notice" role="status">
          {message}
        </p>
      )}
      <section className="today-section connections-card" aria-labelledby="reauthorize-heading">
        <h2 id="reauthorize-heading">Recent reauthorization</h2>
        <p className="workspace-muted">
          Required before creating, testing, assigning, rotating, or revoking a managed connection.
        </p>
        <label className="connections-field">
          Passphrase
          <input
            aria-label="Passphrase"
            type="password"
            autoComplete="current-password"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
          />
        </label>
        <button
          className="workspace-primary"
          disabled={busy === 'reauthorize' || !passphrase}
          onClick={() =>
            void run(
              'reauthorize',
              async () => {
                const next = await reauthorize(passphrase);
                setCsrf(next.csrf);
                setPassphrase('');
              },
              'Reauthorization is active for five minutes.',
            )
          }
        >
          {busy === 'reauthorize' ? 'Reauthorizing…' : 'Reauthorize'}
        </button>
      </section>
      <section className="today-section connections-card" aria-labelledby="connect-jira-heading">
        <h2 id="connect-jira-heading">Connect Jira</h2>
        <p>
          Approved endpoint: <code>{endpoint}</code>. The gateway enforces the reviewed read-only
          template; Jira token permissions are controlled upstream.
        </p>
        <label className="connections-field">
          Label
          <input value={label} maxLength={100} onChange={(event) => setLabel(event.target.value)} />
        </label>
        <label className="connections-field">
          Jira email
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label className="connections-field">
          Jira API token
          <input
            aria-label="Jira API token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
        <fieldset className="connections-profiles">
          <legend>Eligible work profiles</legend>
          {data.eligibleAccounts.length ? (
            data.eligibleAccounts.map((id) => (
              <label key={id}>
                <input
                  type="checkbox"
                  checked={selected.includes(id)}
                  onChange={() => toggle(id)}
                />{' '}
                {id}
              </label>
            ))
          ) : (
            <p className="workspace-muted">No profiles are eligible for managed Jira access.</p>
          )}
        </fieldset>
        <p className="workspace-muted">
          Your API token stays only in this form, is masked, and is cleared after submission or when
          you leave this page.
        </p>
        <button
          className="workspace-primary"
          disabled={busy === 'create' || !label.trim() || !email || !token || !selected.length}
          onClick={() => {
            if (!requireReauthorization()) return;
            const credential = token;
            setToken('');
            void run(
              'create',
              () =>
                createConnection({ label, email, token: credential, accountIds: selected, csrf }),
              'Jira connection verified and activated.',
            );
          }}
        >
          {busy === 'create' ? 'Verifying Jira…' : 'Consent and connect Jira'}
        </button>
      </section>
      <section className="today-section" aria-labelledby="managed-heading">
        <h2 id="managed-heading">Managed connections</h2>
        {data.connections.length === 0 ? (
          <p>No managed Jira connection.</p>
        ) : (
          data.connections.map((connection) => (
            <ConnectionCard
              key={connection.id}
              connection={connection}
              accounts={data.eligibleAccounts}
              csrf={csrf}
              busy={busy}
              audit={audit[connection.id]}
              rotateOpen={rotateId === connection.id}
              rotationToken={rotationToken}
              requireReauthorization={requireReauthorization}
              onRotateOpen={() => {
                setRotateId(connection.id);
                setRotationToken('');
              }}
              onRotationToken={setRotationToken}
              onRotateClose={() => {
                setRotateId(null);
                setRotationToken('');
              }}
              onAction={run}
              onAudit={loadAudit}
            />
          ))
        )}
      </section>
      <section className="today-section">
        <h2>Operator-managed legacy services</h2>
        <p>{data.legacy.length ? data.legacy.join(', ') : 'None reported.'}</p>
        <p className="workspace-muted">
          These providers are managed by the operator and are not migrated or changed here.
        </p>
      </section>
    </main>
  );
}

function ConnectionCard({
  connection,
  accounts,
  csrf,
  busy,
  audit,
  rotateOpen,
  rotationToken,
  requireReauthorization,
  onRotateOpen,
  onRotationToken,
  onRotateClose,
  onAction,
  onAudit,
}: {
  connection: ManagedConnection;
  accounts: string[];
  csrf: string;
  busy: string | null;
  audit?: ConnectionAuditEntry[];
  rotateOpen: boolean;
  rotationToken: string;
  requireReauthorization: () => boolean;
  onRotateOpen: () => void;
  onRotationToken: (value: string) => void;
  onRotateClose: () => void;
  onAction: (name: string, action: () => Promise<unknown>, success: string) => Promise<void>;
  onAudit: (id: string) => Promise<void>;
}) {
  const assigned = connection.desiredAccountIds;
  return (
    <article className="workspace-record connections-record">
      <div>
        <strong>{connection.label}</strong>
        <small>
          {connection.identity ?? 'Identity not verified'} · last tested{' '}
          {time(connection.verifiedAt)}
        </small>
        <small>{status(connection)}</small>
        <fieldset className="connections-profiles">
          <legend>Assigned work profiles</legend>
          {accounts.map((id) => (
            <label key={id}>
              <input
                type="checkbox"
                checked={assigned.includes(id)}
                disabled={busy !== null}
                onChange={() => {
                  if (!requireReauthorization()) return;
                  const accountIds = assigned.includes(id)
                    ? assigned.filter((value) => value !== id)
                    : [...assigned, id];
                  void onAction(
                    `assign:${connection.id}`,
                    () =>
                      updateAssignments({
                        id: connection.id,
                        revision: connection.revision,
                        accountIds,
                        csrf,
                      }),
                    'Assignments updated for new conversations.',
                  );
                }}
              />{' '}
              {id}
            </label>
          ))}
        </fieldset>
      </div>
      <div className="connections-actions">
        <button
          disabled={busy !== null || connection.status === 'revoked'}
          onClick={() => {
            if (requireReauthorization())
              void onAction(
                `test:${connection.id}`,
                () => testConnection({ id: connection.id, revision: connection.revision, csrf }),
                'Identity test completed.',
              );
          }}
        >
          Test identity
        </button>
        <button disabled={busy !== null || connection.status === 'revoked'} onClick={onRotateOpen}>
          Rotate token
        </button>
        <button
          disabled={busy !== null || connection.status === 'revoked'}
          className="connections-danger"
          onClick={() => {
            if (requireReauthorization())
              void onAction(
                `revoke:${connection.id}`,
                () => revokeConnection({ id: connection.id, revision: connection.revision, csrf }),
                'Revocation confirmed. Revoke the upstream Jira token separately if needed.',
              );
          }}
        >
          Revoke
        </button>
        <button
          disabled={busy === `audit:${connection.id}`}
          onClick={() => void onAudit(connection.id)}
        >
          Show audit
        </button>
      </div>
      {rotateOpen && (
        <form
          className="connections-rotate"
          onSubmit={(event) => {
            event.preventDefault();
            if (!requireReauthorization() || !rotationToken) return;
            const credential = rotationToken;
            onRotationToken('');
            onRotateClose();
            void onAction(
              `rotate:${connection.id}`,
              () =>
                rotateConnection({
                  id: connection.id,
                  revision: connection.revision,
                  token: credential,
                  csrf,
                }),
              'Credential rotation completed.',
            );
          }}
        >
          <label className="connections-field">
            Replacement Jira API token
            <input
              aria-label="Replacement Jira API token"
              type="password"
              autoComplete="off"
              value={rotationToken}
              onChange={(event) => onRotationToken(event.target.value)}
            />
          </label>
          <button className="workspace-primary" disabled={busy !== null || !rotationToken}>
            Verify and rotate
          </button>
          <button type="button" onClick={onRotateClose}>
            Cancel
          </button>
        </form>
      )}
      {audit && (
        <ol className="connections-audit" aria-label={`${connection.label} audit history`}>
          {audit.map((entry) => (
            <li key={entry.id}>
              {new Date(entry.createdAt).toLocaleString()}: {entry.operation} {entry.outcome}
              {entry.affectedRefs.length ? ` (${entry.affectedRefs.join(', ')})` : ''}
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}
