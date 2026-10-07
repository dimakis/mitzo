import { useState } from 'react';
import {
  disableCredentialConnection,
  getConnectionSessions,
  revokeConnectionSession,
  rotateCredentialConnection,
  testCredentialConnection,
} from '../lib/credential-connections-api';
import type {
  CredentialConnection,
  ConnectionSessionAccess,
  ConnectionRun,
} from '../types/credential-connections';
export function CredentialConnectionCard({
  connection,
  busy,
  csrf,
  run,
}: {
  connection: CredentialConnection;
  busy: boolean;
  csrf: () => string | undefined;
  run: ConnectionRun;
}) {
  const [testPath, setTestPath] = useState(connection.paths[0]);
  const [sessions, setSessions] = useState<ConnectionSessionAccess[]>();
  const [rotating, setRotating] = useState(false);
  const [secret, setSecret] = useState('');
  const loadSessions = async () => setSessions(await getConnectionSessions(connection.id));
  return (
    <article className="connections-card">
      <h3>{connection.label}</h3>
      <p>
        {connection.endpoint} · {connection.status}
      </p>
      <p>
        {connection.methods.join(', ')} · {connection.paths.join(', ')} ·{' '}
        {connection.verifiedAt
          ? `Verified ${new Date(connection.verifiedAt).toLocaleString()}`
          : 'Not yet verified'}
      </p>
      <>
        {connection.status === 'active' && (
          <>
            <label className="connections-field">
              Test path for {connection.label}
              <input
                disabled={busy}
                value={testPath}
                onChange={(e) => setTestPath(e.target.value)}
              />
            </label>
            <button
              disabled={busy}
              onClick={() => {
                const token = csrf();
                if (token)
                  void run(
                    () =>
                      testCredentialConnection(connection.id, connection.revision, testPath, token),
                    'Authenticated read succeeded. No chat access was granted.',
                  );
              }}
            >
              Test connection
            </button>
          </>
        )}
        <button
          disabled={busy}
          onClick={() => {
            setRotating(true);
            setSecret('');
          }}
        >
          {connection.status === 'disabled' ? 'Replace credential and enable' : 'Update credential'}
        </button>
        {connection.status === 'active' && (
          <>
            <button disabled={busy} onClick={() => void run(loadSessions, '')}>
              Session access
            </button>
            <button
              disabled={busy}
              onClick={() => {
                const token = csrf();
                if (token)
                  void run(async () => {
                    setSessions(undefined);
                    setRotating(false);
                    setSecret('');
                    await disableCredentialConnection(connection.id, connection.revision, token);
                  }, 'Connection disabled and all session access revoked. The Keychain item is retained.');
              }}
            >
              Disable and revoke all access
            </button>
          </>
        )}
        {rotating && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (busy) return;
              const value = secret;
              setSecret('');
              const token = csrf();
              if (!token) return;
              setSessions(undefined);
              void run(
                async () => {
                  await rotateCredentialConnection(
                    connection.id,
                    connection.revision,
                    value,
                    token,
                  );
                  setRotating(false);
                  setSessions(undefined);
                },
                connection.status === 'disabled'
                  ? 'Credential replaced and connection enabled. Each chat needs fresh approval.'
                  : 'Credential updated. Each chat needs fresh approval.',
              );
            }}
          >
            <p>
              Updating revokes every chat’s access before saving a new Mitzo Keychain item. Linked
              items are retained. If saving fails, this connection remains disabled.
            </p>
            <label className="connections-field">
              New credential for {connection.label}
              <input
                required
                type="password"
                name="password"
                disabled={busy}
                maxLength={16384}
                autoComplete={
                  connection.auth.kind === 'basic' || connection.auth.kind === 'password'
                    ? 'current-password'
                    : 'off'
                }
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
              />
            </label>
            <button disabled={busy}>
              {connection.status === 'disabled'
                ? 'Save replacement and enable'
                : 'Save updated credential'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setRotating(false);
                setSecret('');
              }}
            >
              Cancel
            </button>
          </form>
        )}
        {connection.status === 'active' && sessions && (
          <ul>
            {sessions.length ? (
              sessions.map((access) => (
                <li key={access.sessionId}>
                  {access.sessionId}
                  <button
                    disabled={busy}
                    aria-label={`Revoke ${access.sessionId}`}
                    onClick={() => {
                      const token = csrf();
                      if (token)
                        void run(async () => {
                          await revokeConnectionSession(
                            connection.id,
                            access.sessionId,
                            connection.revision,
                            token,
                          );
                          await loadSessions();
                        }, 'Access revoked for this session.');
                    }}
                  >
                    Revoke
                  </button>
                </li>
              ))
            ) : (
              <li>No sessions have access.</li>
            )}
          </ul>
        )}
      </>
    </article>
  );
}
