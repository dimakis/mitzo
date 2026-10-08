import { useState } from 'react';
import { createCredentialConnection } from '../lib/credential-connections-api';
import type {
  ConnectionAuth,
  ConnectionMethod,
  ConnectionRun,
} from '../types/credential-connections';
const methods: ConnectionMethod[] = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
export function CredentialConnectionForm({
  busy,
  csrf,
  run,
}: {
  busy: boolean;
  csrf: () => string | undefined;
  run: ConnectionRun;
}) {
  const [label, setLabel] = useState('Home Assistant');
  const [endpoint, setEndpoint] = useState('');
  const [kind, setKind] = useState<ConnectionAuth['kind']>('bearer');
  const [username, setUsername] = useState('');
  const [headerName, setHeaderName] = useState('X-API-Key');
  const [source, setSource] = useState('new');
  const [secret, setSecret] = useState('');
  const [keychainService, setKeychainService] = useState('');
  const [keychainAccount, setKeychainAccount] = useState('');
  const [paths, setPaths] = useState('/api/');
  const [selectedMethods, setSelectedMethods] = useState<ConnectionMethod[]>(['GET', 'HEAD']);
  const [allowPrivateNetwork, setAllowPrivateNetwork] = useState(false);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (busy) return;
        const credential = secret;
        setSecret('');
        const token = csrf();
        if (!token) return;
        const auth: ConnectionAuth =
          kind === 'basic'
            ? { kind, username }
            : kind === 'bearer'
              ? { kind }
              : { kind, headerName };
        const connection = {
          label,
          endpoint: endpoint.trim().replace(/\/$/, ''),
          auth,
          paths: paths
            .split(',')
            .map((p) => p.trim())
            .filter(Boolean),
          methods: selectedMethods,
          allowPrivateNetwork,
        };
        void run(
          () =>
            createCredentialConnection(
              source === 'new'
                ? { connection, secret: credential }
                : {
                    connection,
                    existing: { service: keychainService, account: keychainAccount },
                  },
              token,
            ),
          'Connection saved. Chats will request approval when they need it.',
        );
      }}
    >
      <h3>Add service connection</h3>
      <fieldset disabled={busy} className="connections-form-fields">
        <legend className="sr-only">Service connection details</legend>
        <label className="connections-field">
          Service template
          <select
            onChange={(e) => {
              const home = e.target.value === 'home-assistant';
              setLabel(home ? 'Home Assistant' : '');
              setKind('bearer');
              setSecret('');
              setUsername('');
              setHeaderName('X-API-Key');
              setPaths(home ? '/api/' : '/');
              setSelectedMethods(['GET', 'HEAD']);
            }}
            defaultValue="home-assistant"
          >
            <option value="home-assistant">Home Assistant</option>
            <option value="custom">Custom HTTPS service</option>
          </select>
        </label>
        <label className="connections-field">
          Connection name
          <input
            required
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={100}
          />
        </label>
        <label className="connections-field">
          Service address
          <input
            required
            type="url"
            autoComplete="url"
            placeholder="https://ha.example.com"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
          />
        </label>
        <label className="connections-field">
          Authentication
          <select
            value={kind}
            onChange={(e) => {
              const next = e.target.value as ConnectionAuth['kind'];
              setKind(next);
              setSecret('');
              setHeaderName(next === 'password' ? 'X-Password' : 'X-API-Key');
            }}
          >
            <option value="bearer">Bearer token</option>
            <option value="basic">Username and password</option>
            <option value="api-key">API key in a header</option>
            <option value="password">Password in a header</option>
          </select>
        </label>
        {kind === 'basic' && (
          <label className="connections-field">
            Username
            <input
              required
              name="username"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
        )}
        {(kind === 'api-key' || kind === 'password') && (
          <label className="connections-field">
            Authentication header
            <input required value={headerName} onChange={(e) => setHeaderName(e.target.value)} />
            <span>Use the header required by this service.</span>
          </label>
        )}
        <label className="connections-field">
          Credential source
          <select
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              setSecret('');
            }}
          >
            <option value="new">Save a new Apple Keychain item</option>
            <option value="existing">Link an existing Keychain item</option>
          </select>
        </label>
        {source === 'new' ? (
          <label className="connections-field">
            Token or password
            <input
              required
              type="password"
              aria-label="Token or password"
              name="password"
              autoComplete={kind === 'basic' || kind === 'password' ? 'current-password' : 'off'}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              maxLength={16384}
            />
            <span>
              Enter it here or use your browser’s password picker for a saved password. It stays out
              of chat and is saved in Mitzo’s own Keychain item. Apple Passwords is not browsed or
              synced.
            </span>
          </label>
        ) : (
          <>
            <p>
              Link a generic password item accessible in Keychain Access on the Mac. Apple Passwords
              entries are not automatically browsed or synced. The Mac may ask you to allow the
              helper.
            </p>
            <label className="connections-field">
              Keychain service
              <input
                required
                value={keychainService}
                onChange={(e) => setKeychainService(e.target.value)}
              />
            </label>
            <label className="connections-field">
              Keychain account
              <input
                required
                value={keychainAccount}
                onChange={(e) => setKeychainAccount(e.target.value)}
              />
            </label>
          </>
        )}
        <details>
          <summary>Allowed requests</summary>
          <p>
            Session approval covers these paths and methods. Start with reads; enable writes only
            when needed.
          </p>
          <label className="connections-field">
            Allowed path prefixes
            <input required value={paths} onChange={(e) => setPaths(e.target.value)} />
            <span>Separate multiple paths with commas.</span>
          </label>
          <fieldset>
            <legend>Request methods</legend>
            {methods.map((method) => (
              <label key={method}>
                <input
                  type="checkbox"
                  checked={selectedMethods.includes(method)}
                  onChange={() =>
                    setSelectedMethods((current) =>
                      current.includes(method)
                        ? current.filter((m) => m !== method)
                        : [...current, method],
                    )
                  }
                />
                {method}{' '}
              </label>
            ))}
          </fieldset>
        </details>
        <label>
          <input
            type="checkbox"
            checked={allowPrivateNetwork}
            onChange={(e) => setAllowPrivateNetwork(e.target.checked)}
          />{' '}
          Allow a private network service (LAN or Tailscale)
        </label>
        <p className="workspace-muted">
          HTTPS is required. Browser sign-in flows and OAuth are not configured through this form.
        </p>
        <button
          className="workspace-primary"
          type="submit"
          disabled={busy || !selectedMethods.length}
        >
          {busy ? 'Working…' : 'Save connection'}
        </button>
      </fieldset>
    </form>
  );
}
