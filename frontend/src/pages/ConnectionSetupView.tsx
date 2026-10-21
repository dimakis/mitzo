import type { SecretRelay } from '../types/secret-relay';
import { UiIcon } from '../components/UiIcon';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  cancelConnectionSetup,
  getSecretRelay,
  completeSecretRelay,
  cancelSecretRelay,
  completeConnectionSetup,
  getConnectionSetup,
  getCachedCredentialAuthorization,
  reauthorizeKeychain,
} from '../lib/credential-connections-api';
import type { ConnectionSetup } from '../types/credential-connections';
import '../styles/connection-setup-card.css';

function setupAccessLabel(setup: ConnectionSetup) {
  return setup.connection.methods.some((method) => !['GET', 'HEAD'].includes(method)) ||
    setup.connection.homeAssistantDashboards === 'read-write'
    ? 'Read and make changes'
    : 'Read only';
}

function documentationUrl(value?: string) {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password
      ? parsed.href
      : undefined;
  } catch {
    return undefined;
  }
}

function DocumentationReference({ url }: { url: string }) {
  const [reviewed, setReviewed] = useState(false);
  return (
    <div className="connection-setup-documentation">
      <p>This reference was provided by your assistant. Enter your key only here in Mitzo.</p>
      <p className="connection-setup-documentation-url">{url}</p>
      <button
        type="button"
        className="workspace-text-link"
        aria-expanded={reviewed}
        onClick={() => setReviewed((current) => !current)}
      >
        Review service documentation
      </button>
      {reviewed && (
        <div className="connection-setup-documentation-review">
          <p>Check that this destination is documentation for the service you want to connect.</p>
          <a href={url} target="_blank" rel="noopener noreferrer">
            Open documentation
          </a>
        </div>
      )}
    </div>
  );
}

/** A chat-prepared connection: the user supplies a credential, never protocol configuration. */
export function ConnectionSetupView({ secretRelay = false }: { secretRelay?: boolean }) {
  const { setupId = '' } = useParams();
  const [setup, setSetup] = useState<ConnectionSetup | SecretRelay>();
  const [error, setError] = useState('');
  const [secret, setSecret] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [authorization, setAuthorization] = useState<
    { csrf: string; expiresAt: number } | undefined
  >(getCachedCredentialAuthorization);
  const inFlight = useRef<number | undefined>(undefined);
  const routeGeneration = useRef(0);
  const requestGeneration = useRef(0);
  const submissionError = useRef('');
  const alive = useRef(false);
  const currentSetupId = useRef(setupId);
  currentSetupId.current = setupId;
  const load = useCallback(async () => {
    const route = routeGeneration.current;
    const request = ++requestGeneration.current;
    const current = () =>
      alive.current &&
      currentSetupId.current === setupId &&
      routeGeneration.current === route &&
      requestGeneration.current === request;
    try {
      const next = await (secretRelay ? getSecretRelay : getConnectionSetup)(setupId);
      if (current()) {
        if (next.error || ['ready', 'cancelled', 'expired', 'unconfirmed'].includes(next.status))
          submissionError.current = '';
        setSetup(next);
        setError(next.error || (next.status === 'pending' ? submissionError.current : ''));
        setUncertain(false);
      }
    } catch (reason) {
      if (current())
        setError(
          submissionError.current ||
            (reason instanceof Error ? reason.message : 'Unable to load setup.'),
        );
      throw reason;
    }
  }, [setupId, secretRelay]);
  useEffect(() => {
    routeGeneration.current += 1;
    alive.current = true;
    setSetup(undefined);
    setSecret('');
    setPassphrase('');
    setError('');
    submissionError.current = '';
    setBusy(false);
    setUncertain(false);
    setAuthorization(getCachedCredentialAuthorization());
    void load().catch(() => undefined);
    return () => {
      routeGeneration.current += 1;
      alive.current = false;
    };
  }, [load]);
  useEffect(() => {
    if (!authorization) return;
    const timer = setTimeout(
      () => {
        setAuthorization(undefined);
        setSecret('');
      },
      Math.max(0, authorization.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [authorization]);
  useEffect(() => {
    if (
      !setup ||
      ['cancelled', 'expired', 'unconfirmed'].includes(setup.status) ||
      (setup.status === 'ready' && !('targets' in setup))
    )
      return;
    const timer = setTimeout(
      () => {
        setSecret('');
        setPassphrase('');
        setSetup((current) =>
          current &&
          current.status !== 'cancelled' &&
          (current.status !== 'ready' || 'targets' in current)
            ? { ...current, status: 'expired' }
            : current,
        );
      },
      Math.max(0, setup.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [setup]);
  useEffect(() => {
    if (setup?.status !== 'verifying') return;
    let polling = false;
    const timer = setInterval(() => {
      if (polling) return;
      polling = true;
      void load()
        .catch(() => undefined)
        .finally(() => {
          polling = false;
        });
    }, 1500);
    return () => clearInterval(timer);
  }, [setup, load]);
  const mutate = async (cancel = false) => {
    const route = routeGeneration.current;
    if (
      !setup ||
      inFlight.current === route ||
      uncertain ||
      (setup.status !== 'pending' && !(cancel && secretRelay && setup.status === 'ready'))
    )
      return;
    const request = ++requestGeneration.current;
    const current = () =>
      alive.current &&
      currentSetupId.current === setupId &&
      routeGeneration.current === route &&
      requestGeneration.current === request;
    const credential = secret;
    const unlock = passphrase;
    submissionError.current = '';
    setSecret('');
    setPassphrase('');
    setError('');
    setBusy(true);
    inFlight.current = route;
    let mutationStarted = false;
    try {
      const auth =
        authorization && authorization.expiresAt > Date.now()
          ? authorization
          : await reauthorizeKeychain(unlock);
      if (!current()) return;
      setAuthorization(auth);
      mutationStarted = true;
      const next = cancel
        ? await (secretRelay ? cancelSecretRelay : cancelConnectionSetup)(
            setup.id,
            setup.revision,
            auth.csrf,
          )
        : await (secretRelay ? completeSecretRelay : completeConnectionSetup)(
            setup.id,
            setup.revision,
            credential,
            auth.csrf,
          );
      if (current()) {
        setSetup(next);
        setError(next.error ?? '');
      }
    } catch (reason) {
      if (!current()) return;
      if (mutationStarted) {
        setAuthorization(undefined);
        setUncertain(true);
        submissionError.current =
          reason instanceof Error ? reason.message : 'Unable to complete setup.';
        // A lost response may follow a successful save. Check before accepting another key.
        await load().catch(() => undefined);
      } else setAuthorization(undefined);
      if (current() && !mutationStarted)
        setError(reason instanceof Error ? reason.message : 'Unable to authorize setup.');
    } finally {
      if (inFlight.current === route) inFlight.current = undefined;
      if (alive.current && routeGeneration.current === route) setBusy(false);
    }
  };
  const relay = setup && 'targets' in setup ? setup : undefined;
  const connectionSetup = setup && 'connection' in setup ? setup : undefined;
  const label = relay?.label ?? connectionSetup?.connection.label ?? '';
  const credentialLabel = relay ? 'Password or token' : connectionSetup?.credential.label;
  const back = setup ? `/chat/${encodeURIComponent(setup.sessionId)}` : '/connections-access';
  const terminal = setup && ['ready', 'cancelled', 'expired', 'unconfirmed'].includes(setup.status);
  const expired = setup?.status === 'expired';
  const ready = setup?.status === 'ready';
  const needsUnlock = !authorization || authorization.expiresAt <= Date.now();
  const helpUrl = connectionSetup?.credential.helpUrl;
  const safeHelpUrl = documentationUrl(helpUrl);
  const trustedHomeAssistantHelp =
    connectionSetup?.profile === 'home-assistant' &&
    safeHelpUrl === 'https://www.home-assistant.io/docs/authentication/';
  return (
    <main className="workspace-page connection-setup-page">
      <Link className="connections-back workspace-text-link" to={back}>
        <UiIcon name="back" size={16} />
        {setup ? 'Back to chat' : 'Connections'}
      </Link>
      <section className="connection-setup-surface" aria-labelledby="connection-setup-heading">
        <p className="connection-setup-eyebrow">
          {ready ? 'Ready to continue' : 'Requested in your chat'}
        </p>
        <h1 id="connection-setup-heading">
          {ready
            ? relay
              ? `${label} saved securely`
              : `${label} is connected`
            : expired
              ? 'This setup has expired'
              : setup?.status === 'cancelled'
                ? 'Setup cancelled'
                : setup?.status === 'unconfirmed'
                  ? 'Check secret storage'
                  : setup
                    ? relay
                      ? `Add ${label}`
                      : `Connect ${label}`
                    : 'Connect your service'}
        </h1>
        {!setup ? (
          <>
            {!error && <p role="status">Loading your connection…</p>}
            {error && <p role="alert">{error}</p>}
            {error && <button onClick={() => void load().catch(() => undefined)}>Retry</button>}
          </>
        ) : terminal ? (
          <>
            <p>
              {setup.status === 'unconfirmed'
                ? 'The Gateway save could not be confirmed. Do not enter the value again. Return to chat and review Gateway status with your operator.'
                : ready
                  ? relay
                    ? 'Your value is stored privately in OpenShell. Mitzo will continue the original task when your chat is available.'
                    : setup.delivery === 'pending'
                      ? 'Your key is saved privately and the connection is verified. Return to chat; if the task is waiting, tell your assistant the connection is ready.'
                      : 'Your key is saved privately and the connection is verified. Continue your original task in chat.'
                  : expired
                    ? 'Return to your chat and ask the assistant to prepare this connection again.'
                    : 'Return to your chat whenever you want to continue.'}
            </p>
            {ready && relay && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void mutate(true);
                }}
              >
                {error && <p role="alert">{error}</p>}
                {needsUnlock && (
                  <label className="connections-field">
                    Mitzo passphrase
                    <input
                      type="password"
                      autoComplete="current-password"
                      required
                      value={passphrase}
                      onChange={(event) => setPassphrase(event.target.value)}
                    />
                  </label>
                )}
                <button
                  type="submit"
                  className="workspace-text-link"
                  disabled={busy || (needsUnlock && !passphrase)}
                >
                  Revoke relay access
                </button>
              </form>
            )}
            <Link className="workspace-primary connection-setup-return" to={back}>
              Return to chat
            </Link>
          </>
        ) : (
          <>
            <p className="connection-setup-intro">
              {relay
                ? 'Review where Mitzo may send this value, then enter it privately. Saving allows your assistant to continue with these exact writes.'
                : 'Your assistant has prepared the connection. Add your key to finish.'}
            </p>
            {relay ? (
              <>
                {relay.targets.map((target, index) => (
                  <section
                    className="secret-relay-destination"
                    key={index}
                    aria-label={`Destination ${index + 1}`}
                  >
                    <h2>{target.label}</h2>
                    {target.lanEndpoint && (
                      <p role="note">
                        This device uses unencrypted HTTP on your local network. Saving permits
                        Mitzo to send the value to this exact address.
                      </p>
                    )}
                    <dl className="connection-setup-summary">
                      <div>
                        <dt>Service address</dt>
                        <dd>{target.endpoint}</dd>
                      </div>
                      <div>
                        <dt>Action</dt>
                        <dd>
                          {target.method} {target.path}
                        </dd>
                      </div>
                      <div>
                        <dt>Secret fields</dt>
                        <dd>{target.fields.join(', ')}</dd>
                      </div>
                    </dl>
                    <details>
                      <summary>Review request template</summary>
                      <pre>{target.body}</pre>
                    </details>
                  </section>
                ))}
                <p className="connection-setup-privacy">
                  OpenShell stores your value. Mitzo applies it privately to these fields; your
                  assistant receives only status. Access ends when this request expires or you
                  revoke it.
                </p>
              </>
            ) : (
              connectionSetup && (
                <>
                  <dl className="connection-setup-summary">
                    <div>
                      <dt>Service address</dt>
                      <dd>{connectionSetup.connection.endpoint}</dd>
                    </div>
                    <div>
                      <dt>Available access</dt>
                      <dd>{setupAccessLabel(connectionSetup)}</dd>
                    </div>
                  </dl>
                  <p className="connection-setup-privacy">
                    Your key stays out of chat. Each chat requests permission before using this
                    connection.
                  </p>
                </>
              )
            )}
            {error && (
              <p className="connections-notice" role="alert">
                {error}
              </p>
            )}
            {uncertain ? (
              <div role="status">
                <p>
                  Checking whether your connection was saved. Refresh its status before trying
                  again.
                </p>
                <button disabled={busy} onClick={() => void load().catch(() => undefined)}>
                  Check setup status
                </button>
              </div>
            ) : (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void mutate();
                }}
              >
                <label className="connections-field">
                  {credentialLabel}
                  <input
                    type="password"
                    name="service-credential"
                    autoComplete="off"
                    required
                    disabled={busy || setup.status === 'verifying'}
                    maxLength={16384}
                    value={secret}
                    onChange={(event) => setSecret(event.target.value)}
                  />
                </label>
                <div className="connection-setup-guidance">
                  <p>
                    {relay
                      ? 'Enter the value once. It will fill each approved secret field. Never send it in chat.'
                      : connectionSetup?.credential.instructions}
                  </p>
                  {safeHelpUrl &&
                    (trustedHomeAssistantHelp ? (
                      <a href={safeHelpUrl} target="_blank" rel="noopener noreferrer">
                        Where to get your key <UiIcon name="external" size={16} />
                      </a>
                    ) : (
                      <DocumentationReference
                        key={`${setup.id}:${safeHelpUrl}`}
                        url={safeHelpUrl}
                      />
                    ))}
                </div>
                {needsUnlock && (
                  <label className="connections-field connection-setup-unlock">
                    Mitzo passphrase
                    <input
                      type="password"
                      name="mitzo-passphrase"
                      aria-label="Mitzo passphrase"
                      autoComplete="current-password"
                      required
                      disabled={busy}
                      value={passphrase}
                      onChange={(event) => setPassphrase(event.target.value)}
                    />
                    <span>Authorize saving this {relay ? 'value' : 'key'}.</span>
                  </label>
                )}
                <div className="connection-setup-actions">
                  <button
                    className="workspace-primary"
                    disabled={
                      busy ||
                      !secret ||
                      (needsUnlock && !passphrase) ||
                      setup.status === 'verifying'
                    }
                  >
                    {busy || setup.status === 'verifying'
                      ? relay
                        ? 'Saving securely…'
                        : 'Verifying connection…'
                      : relay
                        ? 'Save securely and continue'
                        : `Connect ${label}`}
                  </button>
                  <button
                    type="button"
                    className="workspace-text-link"
                    disabled={busy || (needsUnlock && !passphrase) || setup.status === 'verifying'}
                    onClick={() => void mutate(true)}
                  >
                    Cancel setup
                  </button>
                </div>
              </form>
            )}
          </>
        )}
      </section>
    </main>
  );
}
