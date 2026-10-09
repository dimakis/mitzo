import { useCallback, useEffect, useState } from 'react';
import { CredentialConnectionForm } from './CredentialConnectionForm';
import { CredentialConnectionCard } from './CredentialConnectionCard';
import { getCredentialConnections, reauthorizeKeychain } from '../lib/credential-connections-api';
import type {
  CredentialConnection,
  CredentialConnectionTemplate,
} from '../types/credential-connections';

export function CredentialConnectionsPanel({
  connectionId,
  initialTemplate = 'home-assistant',
}: { connectionId?: string; initialTemplate?: CredentialConnectionTemplate } = {}) {
  const [connections, setConnections] = useState<CredentialConnection[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [authorization, setAuthorization] = useState<{ csrf: string; expiresAt: number }>();
  const refresh = useCallback(async () => {
    try {
      setConnections(await getCredentialConnections());
      setLoadError('');
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Unable to load service connections.');
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!authorization) return;
    const timer = setTimeout(
      () => {
        setAuthorization(undefined);
        setMessage('Keychain authorization expired. Authorize changes again to continue.');
      },
      Math.max(0, authorization.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [authorization]);
  const csrf = () => {
    if (authorization && authorization.expiresAt > Date.now()) return authorization.csrf;
    setAuthorization(undefined);
    setMessage('Authorize Keychain changes before continuing.');
    return undefined;
  };
  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setMessage('');
    try {
      await action();
      setMessage(success);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Connection operation failed.');
    } finally {
      // Rotation may revoke access and disable a connection even when the vault write fails.
      await refresh();
      setBusy(false);
    }
  };
  return (
    <section
      className="today-section connections-card credential-connections-panel"
      aria-labelledby="keychain-connections-heading"
    >
      <h2 id="keychain-connections-heading">
        {initialTemplate === 'custom'
          ? 'Authenticated API connections'
          : 'Apple Keychain connections'}
      </h2>
      <p className="credential-connections-intro">
        Ask your assistant to connect a service in chat. It prepares the setup and brings you here
        only to add your key.
      </p>
      {message && (
        <p role="status" className="connections-notice">
          {message}
        </p>
      )}
      {loadError ? (
        <>
          <p>{loadError}</p>
          <button disabled={busy} onClick={() => void refresh()}>
            Retry service connections
          </button>
        </>
      ) : connections === null ? (
        <p>Loading service connections…</p>
      ) : (
        <>
          {authorization && (
            <p>
              Changes authorized until {new Date(authorization.expiresAt).toLocaleTimeString()}.
            </p>
          )}
          <details>
            <summary>Authorize setup and changes</summary>
            <p>
              Required to save, test, rotate or revoke connections. This does not approve access for
              any chat.
            </p>
            <label className="connections-field">
              Keychain setup passphrase
              <input
                type="password"
                name="keychain-setup-passphrase"
                disabled={busy}
                autoComplete="current-password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
              />
            </label>
            <button
              disabled={busy || !passphrase}
              onClick={() => {
                const value = passphrase;
                setPassphrase('');
                setAuthorization(undefined);
                void run(
                  async () => setAuthorization(await reauthorizeKeychain(value)),
                  'Keychain changes authorized.',
                );
              }}
            >
              Authorize Keychain changes
            </button>
          </details>
          {!connectionId && (
            <details className="credential-manual-setup">
              <summary>Advanced manual setup</summary>
              <CredentialConnectionForm
                busy={busy}
                csrf={csrf}
                run={run}
                initialTemplate={initialTemplate}
              />
            </details>
          )}
          {connectionId && !connections.some((connection) => connection.id === connectionId) && (
            <p>
              This connection is no longer available. Return to Connections to refresh its status.
            </p>
          )}
          {connections
            .filter((connection) => !connectionId || connection.id === connectionId)
            .map((connection) => (
              <CredentialConnectionCard
                key={connection.id}
                connection={connection}
                busy={busy}
                csrf={csrf}
                run={run}
              />
            ))}
        </>
      )}
    </section>
  );
}
