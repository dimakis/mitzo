import { useCallback, useEffect, useState } from 'react';
import {
  getGoogleWorkspaceStatus,
  previewGoogleWorkspace,
  reconnectGoogleWorkspace,
  refreshGoogleWorkspace,
} from '../lib/connections-api';
import type { GoogleWorkspaceHealth } from '../types/connections';

export function GoogleWorkspaceControls({
  csrf,
  authorized,
  onReauthorizationNeeded,
}: {
  csrf: string;
  authorized: boolean;
  onReauthorizationNeeded: () => void;
}) {
  const [status, setStatus] = useState<GoogleWorkspaceHealth | null>(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const refresh = useCallback(async () => {
    try {
      setStatus(await getGoogleWorkspaceStatus());
    } catch {
      setStatus({ health: 'unavailable', expiresAt: null, slidesEditing: false });
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const mutate = async (action: () => Promise<void>) => {
    if (!authorized) {
      onReauthorizationNeeded();
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      await action();
    } catch (error) {
      setEmail('');
      setMessage(
        error instanceof Error
          ? error.message
          : 'Google recovery could not be confirmed. Check its status and retry.',
      );
      await refresh();
    } finally {
      setBusy(false);
    }
  };
  const ready = status?.health === 'ready' && !!status.expiresAt && status.expiresAt > Date.now();
  return (
    <section className="today-section connections-card" aria-labelledby="google-workspace-heading">
      <h2 id="google-workspace-heading">Google Workspace</h2>
      <p role="status">
        {ready
          ? 'Google connection is ready'
          : status?.health === 'needs_sign_in'
            ? 'Google sign-in needs attention'
            : 'Google connection status is unavailable'}
      </p>
      <p className="workspace-muted">
        {status?.slidesEditing
          ? 'Slides creation and editing are enabled.'
          : 'Slides editing needs a provider policy update.'}{' '}
        Drive, Docs, Sheets and Calendar access is read-only.
      </p>
      <p className="workspace-muted">
        Chats use this connection after you approve Google access. Recovery also updates chats that
        already have access.
      </p>
      {status?.expiresAt && ready && (
        <p>Next token expiry: {new Date(status.expiresAt).toLocaleString()}</p>
      )}
      {message && <p role="alert">{message}</p>}
      <div className="connections-actions">
        <button disabled={busy} onClick={() => void refresh()}>
          Check Google status
        </button>
        <button
          disabled={busy}
          onClick={() =>
            void mutate(async () => {
              setStatus(await refreshGoogleWorkspace(csrf));
            })
          }
        >
          Refresh Google token
        </button>
        <button
          disabled={busy}
          onClick={() =>
            void mutate(async () => {
              setEmail((await previewGoogleWorkspace(csrf)).email);
            })
          }
        >
          Review Google account
        </button>
      </div>
      {email && (
        <div>
          <p>
            Reconnect Google as <strong>{email}</strong> using the existing Google sign-in on the
            Mitzo computer.
          </p>
          <p className="workspace-muted">
            This restores Drive access and read-only Calendar access. Gmail requires separate
            authorization.
          </p>
          <button
            disabled={busy}
            className="workspace-primary"
            onClick={() =>
              void mutate(async () => {
                setStatus(await reconnectGoogleWorkspace(csrf, email));
                setEmail('');
              })
            }
          >
            Reconnect Google
          </button>
          <button disabled={busy} onClick={() => setEmail('')}>
            Cancel
          </button>
        </div>
      )}
    </section>
  );
}
