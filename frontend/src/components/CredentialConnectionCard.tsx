import { CredentialWebSocketSettings } from './CredentialWebSocketSettings';
import { websocketDraft, websocketConfiguration } from '../lib/credential-websocket-settings';
import { useEffect, useRef, useState } from 'react';
import {
  disableCredentialConnection,
  getConnectionSessions,
  revokeConnectionSession,
  rotateCredentialConnection,
  updateDashboardAccess,
  updateConnectionWebSocket,
  testCredentialConnection,
} from '../lib/credential-connections-api';
import type {
  CredentialConnection,
  ConnectionSessionAccess,
  DashboardAccess,
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
  const [websocket, setWebsocket] = useState(() => websocketDraft(connection.websocket));
  const savedWebsocket = JSON.stringify(connection.websocket ?? null);
  const lastSavedWebsocket = useRef({
    configuration: savedWebsocket,
    revision: connection.revision,
  });
  useEffect(() => {
    const previous = lastSavedWebsocket.current;
    if (previous.configuration === savedWebsocket && previous.revision === connection.revision)
      return;
    lastSavedWebsocket.current = { configuration: savedWebsocket, revision: connection.revision };
    setWebsocket(websocketDraft(JSON.parse(savedWebsocket)));
  }, [savedWebsocket, connection.revision]);
  const [testPath, setTestPath] = useState(connection.paths[0]);
  const [sessions, setSessions] = useState<ConnectionSessionAccess[]>();
  const [rotating, setRotating] = useState(false);
  const [secret, setSecret] = useState('');
  const [dashboardAccess, setDashboardAccess] = useState<DashboardAccess>(
    connection.homeAssistantDashboards ?? 'disabled',
  );
  const savedDashboardAccess = connection.homeAssistantDashboards ?? 'disabled';
  const lastSavedDashboard = useRef({
    access: savedDashboardAccess,
    revision: connection.revision,
  });
  useEffect(() => {
    const previous = lastSavedDashboard.current;
    if (previous.access === savedDashboardAccess && previous.revision === connection.revision)
      return;
    lastSavedDashboard.current = { access: savedDashboardAccess, revision: connection.revision };
    setDashboardAccess(savedDashboardAccess);
  }, [savedDashboardAccess, connection.revision]);
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
      {connection.status === 'active' && (
        <>
          <CredentialWebSocketSettings
            label={connection.label}
            draft={websocket}
            onChange={setWebsocket}
            disabled={busy}
          />
          <button
            disabled={
              busy ||
              JSON.stringify(websocket) === JSON.stringify(websocketDraft(connection.websocket))
            }
            onClick={() => {
              const token = csrf();
              if (token)
                void run(async () => {
                  await updateConnectionWebSocket(
                    connection.id,
                    connection.revision,
                    websocketConfiguration(websocket),
                    token,
                  );
                  setSessions(undefined);
                }, 'WebSocket setup updated. Each chat needs fresh approval.');
            }}
          >
            Save WebSocket setup
          </button>
        </>
      )}
      {connection.status === 'active' && connection.auth.kind === 'bearer' && (
        <>
          <label className="connections-field">
            Dashboard API access for {connection.label}
            <select
              disabled={busy}
              value={dashboardAccess}
              onChange={(e) => setDashboardAccess(e.target.value as DashboardAccess)}
            >
              <option value="disabled">Disabled</option>
              <option value="read">Read dashboards</option>
              <option value="read-write">Read and update dashboards</option>
            </select>
          </label>
          <p>
            Changing dashboard access revokes existing chat approvals. Updates use Home Assistant's
            WebSocket API and require an HA administrator account.
          </p>
          <button
            disabled={
              busy || dashboardAccess === (connection.homeAssistantDashboards ?? 'disabled')
            }
            onClick={() => {
              const token = csrf();
              if (token)
                void run(async () => {
                  await updateDashboardAccess(
                    connection.id,
                    connection.revision,
                    dashboardAccess,
                    token,
                  );
                  setSessions(undefined);
                }, 'Dashboard access updated. Each chat needs fresh approval.');
            }}
          >
            Save dashboard access
          </button>
        </>
      )}
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
