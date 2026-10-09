import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  cancelConnectionSetup,
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

/** A chat-prepared connection: the user supplies a credential, never protocol configuration. */
export function ConnectionSetupView() {
  const { setupId = '' } = useParams();
  const [setup, setSetup] = useState<ConnectionSetup>();
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
      const next = await getConnectionSetup(setupId);
      if (current()) {
        setSetup(next);
        setError(next.error ?? '');
        setUncertain(false);
      }
    } catch (reason) {
      if (current()) setError(reason instanceof Error ? reason.message : 'Unable to load setup.');
      throw reason;
    }
  }, [setupId]);
  useEffect(() => {
    routeGeneration.current += 1;
    alive.current = true;
    setSetup(undefined);
    setSecret('');
    setPassphrase('');
    setError('');
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
    if (!setup || ['ready', 'cancelled', 'expired'].includes(setup.status)) return;
    const timer = setTimeout(
      () => {
        setSecret('');
        setPassphrase('');
        setSetup((current) =>
          current && !['ready', 'cancelled'].includes(current.status)
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
    if (!setup || inFlight.current === route || uncertain || setup.status !== 'pending') return;
    const request = ++requestGeneration.current;
    const current = () =>
      alive.current &&
      currentSetupId.current === setupId &&
      routeGeneration.current === route &&
      requestGeneration.current === request;
    const credential = secret;
    const unlock = passphrase;
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
        ? await cancelConnectionSetup(setup.id, setup.revision, auth.csrf)
        : await completeConnectionSetup(setup.id, setup.revision, credential, auth.csrf);
      if (current()) {
        setSetup(next);
        setError(next.error ?? '');
      }
    } catch (reason) {
      if (!current()) return;
      if (mutationStarted) {
        setAuthorization(undefined);
        setUncertain(true);
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
  const back = setup ? `/chat/${encodeURIComponent(setup.sessionId)}` : '/connections-access';
  const terminal = setup && ['ready', 'cancelled', 'expired'].includes(setup.status);
  const expired = setup?.status === 'expired';
  const ready = setup?.status === 'ready';
  const needsUnlock = !authorization || authorization.expiresAt <= Date.now();
  const helpUrl = setup?.credential.helpUrl;
  const safeHelpUrl = helpUrl && /^https:\/\//i.test(helpUrl) ? helpUrl : undefined;
  return (
    <main className="workspace-page connection-setup-page">
      <Link className="connections-back workspace-text-link" to={back}>
        {setup ? 'Back to chat' : 'Connections'}
      </Link>
      <section className="connection-setup-surface" aria-labelledby="connection-setup-heading">
        <p className="connection-setup-eyebrow">
          {ready ? 'Ready to continue' : 'Requested in your chat'}
        </p>
        <h1 id="connection-setup-heading">
          {ready
            ? `${setup.connection.label} is connected`
            : expired
              ? 'This setup has expired'
              : setup?.status === 'cancelled'
                ? 'Setup cancelled'
                : setup
                  ? `Connect ${setup.connection.label}`
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
              {ready
                ? setup.delivery === 'pending'
                  ? 'Your key is saved privately and the connection is verified. Return to chat; if the task is waiting, tell your assistant the connection is ready.'
                  : 'Your key is saved privately and the connection is verified. Continue your original task in chat.'
                : expired
                  ? 'Return to your chat and ask the assistant to prepare this connection again.'
                  : 'Return to your chat whenever you want to continue.'}
            </p>
            <Link className="workspace-primary connection-setup-return" to={back}>
              Return to chat
            </Link>
          </>
        ) : (
          <>
            <p className="connection-setup-intro">
              Your assistant has prepared the connection. Add your key to finish.
            </p>
            <dl className="connection-setup-summary">
              <div>
                <dt>Service address</dt>
                <dd>{setup.connection.endpoint}</dd>
              </div>
              <div>
                <dt>Available access</dt>
                <dd>{setupAccessLabel(setup)}</dd>
              </div>
            </dl>
            <p className="connection-setup-privacy">
              Your key stays out of chat. Each chat requests permission before using this
              connection.
            </p>
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
                  {setup.credential.label}
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
                  <p>{setup.credential.instructions}</p>
                  {safeHelpUrl && (
                    <a href={safeHelpUrl} target="_blank" rel="noopener noreferrer">
                      Where to get your key ↗
                    </a>
                  )}
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
                    <span>Authorize saving this key.</span>
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
                      ? 'Verifying connection…'
                      : `Connect ${setup.connection.label}`}
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
