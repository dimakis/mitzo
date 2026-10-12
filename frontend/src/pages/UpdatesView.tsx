import { Link } from 'react-router-dom';
import { WorkspacePageHeading } from '../components/WorkspacePageHeading';
import { UiIcon } from '../components/UiIcon';
import { useMitzoUpdates } from '../hooks/useMitzoUpdates';
import '../styles/chat-drafts.css';
export function UpdatesView() {
  const { version, action, loading, checking, error, check } = useMitzoUpdates();
  const params = new URLSearchParams();
  if (action?.prompt) params.set('prompt', action.prompt);
  if (action?.cwd) params.set('cwd', action.cwd);
  if (action?.extraTools) params.set('extraTools', action.extraTools);
  const reviewUrl = `/chat?${params}`;
  return (
    <main className="workspace-page updates-page">
      <Link to="/settings" className="drafts-back">
        <UiIcon name="back" size={16} /> Settings
      </Link>
      <WorkspacePageHeading
        title="Updates"
        description="Keep Mitzo up to date, on your schedule."
      />
      {error && (
        <p role="alert" className="updates-error">
          {error}
        </p>
      )}
      <section className="mitzo-update-panel" aria-live="polite" aria-busy={loading || checking}>
        <div className="mitzo-update-header">
          <UiIcon name="download" size={24} />
          <span className="saved-draft-settings">
            {loading
              ? 'Checking version'
              : version
                ? version.updateAvailable
                  ? 'Update available'
                  : 'Current release'
                : 'Status unavailable'}
          </span>
        </div>
        <h2>
          {loading
            ? 'Loading update information…'
            : version
              ? version.updateAvailable
                ? 'A new Mitzo is ready'
                : 'You’re up to date'
              : 'Update status unavailable'}
        </h2>
        <p className="workspace-muted">
          {version?.updateAvailable
            ? 'Review the update in a new chat, then decide when to apply it.'
            : 'Check for the latest accepted release whenever you like.'}
        </p>
        {version?.updateAvailable &&
          (action?.prompt ? (
            <Link className="workspace-primary" to={reviewUrl}>
              Review update <UiIcon name="right" size={16} />
            </Link>
          ) : (
            <p className="workspace-muted">
              An update action hasn’t been configured for this installation.
            </p>
          ))}
      </section>
      <dl className="mitzo-version-details">
        <div>
          <dt>Installed commit</dt>
          <dd>{version?.commit ? <code>{version.commit.slice(0, 8)}</code> : 'Unavailable'}</dd>
        </div>
        <div>
          <dt>Interface build</dt>
          <dd>{version?.hash ?? 'Unavailable'}</dd>
        </div>
      </dl>
      <p className="workspace-muted">
        You can keep using Mitzo until you choose to update. Applying an update may briefly
        interrupt access.
      </p>
      <div className="mitzo-update-actions">
        <button
          className="home-secondary"
          disabled={loading || checking}
          onClick={() => void check()}
        >
          {checking ? 'Checking…' : 'Check for updates'}
        </button>
        <button
          className="home-secondary"
          onClick={async () => {
            try {
              if ('caches' in window) {
                const keys = await caches.keys();
                await Promise.all(keys.map((key) => caches.delete(key)));
              }
            } catch {
              /* Reload remains available when cache storage is restricted. */
            } finally {
              window.location.reload();
            }
          }}
        >
          Reload interface
        </button>
      </div>
    </main>
  );
}
