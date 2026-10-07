import { Link } from 'react-router-dom';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BackupOverview, BackupRunStatus } from '@mitzo/protocol';
import { UiIcon } from '../components/UiIcon';
import { WorkspacePageHeading } from '../components/WorkspacePageHeading';
import { backupAction, getBackups } from '../lib/backups-api';
import './BackupsView.css';
const labels: Record<BackupRunStatus, string> = {
  capturing: 'Capturing stores',
  encrypting: 'Encrypting and verifying',
  publishing: 'Exporting to iCloud',
  pending: 'Waiting for iCloud',
  uploaded: 'iCloud upload confirmed',
  failed: 'Backup failed',
  interrupted: 'Unresolved run — operator check required',
};
function date(value?: string | null) {
  return value ? new Date(value).toLocaleString() : null;
}
function bytes(value: number) {
  return (
    new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value / (1024 * 1024)) +
    ' MiB'
  );
}
export function BackupsView() {
  const [view, setView] = useState<BackupOverview>();
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupStep, setSetupStep] = useState(0);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const mounted = useRef(false);
  const reading = useRef(false);
  const sending = useRef(false);
  const load = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    try {
      const next = await getBackups();
      if (mounted.current) {
        setView(next);
        setError('');
      }
    } catch {
      if (mounted.current) setError('Backup status unavailable. Refresh to retry.');
    } finally {
      reading.current = false;
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void load();
    const timer = setInterval(() => {
      void load();
    }, 5000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [load]);
  const action = async (kind: 'run' | 'refresh') => {
    if (sending.current) return;
    sending.current = true;
    setSubmitting(true);
    try {
      await backupAction(kind);
      await load();
    } catch {
      if (mounted.current)
        setError('Backup unavailable or busy. Check setup and status, then refresh.');
    } finally {
      sending.current = false;
      if (mounted.current) setSubmitting(false);
    }
  };
  const blocked = !view?.ready || view.busy || submitting || !!error;
  const pending = view?.runs.some((run) => run.status === 'pending');
  const actionHelp = error
    ? 'Refresh status to reconnect before taking an action.'
    : !view?.ready
      ? 'Complete setup on this Mac before running a backup.'
      : view.busy || submitting
        ? 'Backup storage is busy. Wait for the current action to finish.'
        : !pending
          ? 'Run a backup first to check its iCloud upload.'
          : 'An encrypted backup is waiting for iCloud upload confirmation.';
  const latestExport = view?.runs.find((run) => run.bytes !== undefined);
  const controls = (
    <section className="backup-operation" aria-label="Backup actions">
      <div className="backup-controls">
        <button
          className={view?.ready ? 'workspace-primary' : ''}
          disabled={blocked}
          aria-describedby="backup-action-help"
          onClick={() => void action('run')}
        >
          {submitting ? 'Working…' : 'Back up now'}
        </button>
        <button
          disabled={blocked || !pending}
          aria-describedby="backup-action-help"
          onClick={() => void action('refresh')}
        >
          Check iCloud upload
        </button>
      </div>
      <p id="backup-action-help" className="workspace-muted">
        {actionHelp}
      </p>
    </section>
  );
  return (
    <main className="workspace-page backups-page">
      <Link className="workspace-text-link" to="/settings">
        ← Settings
      </Link>
      <WorkspacePageHeading
        title="Backups"
        description="Encrypted backups to your iCloud storage."
      />
      {error && (
        <p role="alert" className="backup-error">
          {error}
        </p>
      )}
      {!view && error && <button onClick={() => void load()}>Refresh status</button>}
      {!view && !error && <p role="status">Loading backup status…</p>}
      {!view && controls}
      {view && (
        <>
          <section className="backup-destination" aria-label="iCloud backup destination">
            <div className="backup-destination-heading">
              <span className="backup-destination-icon">
                <UiIcon name="shield" />
              </span>
              <div>
                <h2>iCloud Drive</h2>
                <p className="workspace-muted">Encrypted storage · Manual backups</p>
              </div>
              <span className="backup-badge">{view.ready ? 'Configured' : 'Setup required'}</span>
            </div>
            <p className="backup-destination-copy">
              {view.ready
                ? 'Your backup destination is configured. Run a backup to capture the included databases.'
                : 'Connect backup storage on this Mac to start protecting your Mitzo and Telos databases.'}
            </p>
            <div className="backup-controls">
              <button
                className="workspace-primary"
                aria-expanded={setupOpen}
                aria-controls="backup-setup"
                onClick={() => setSetupOpen(!setupOpen)}
              >
                {view.ready ? 'View setup' : 'Set up backups'}
              </button>
              <button disabled={submitting} onClick={() => void load()}>
                Refresh status
              </button>
            </div>
            {view.setup.length > 0 && (
              <details className="backup-details">
                <summary>Outstanding setup requirements</summary>
                <ul>
                  {view.setup.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ul>
              </details>
            )}
            {setupOpen && (
              <section id="backup-setup" className="backup-setup" aria-label="Backup setup guide">
                <h3>Set up on this Mac</h3>
                <p className="workspace-muted">
                  The Mac running Mitzo owns this configuration. These steps explain what to set up;
                  they do not change your Mac from the browser.
                </p>
                <div className="backup-steps" aria-label="Setup steps">
                  {['Storage and tools', 'Encryption and recovery', 'Verify setup'].map(
                    (step, index) => (
                      <button
                        key={step}
                        aria-pressed={setupStep === index}
                        onClick={() => setSetupStep(index)}
                      >
                        <span aria-hidden="true">{index + 1}</span>
                        {step}
                      </button>
                    ),
                  )}
                </div>
                <div className="backup-step-content">
                  {setupStep === 0 && (
                    <>
                      <h4>Choose your backup storage</h4>
                      <p>
                        Use a private local backup folder and a separate dedicated folder in iCloud
                        Drive. Install Restic and compile the macOS upload-status helper.
                      </p>
                      <p>Configure these absolute paths in the Mitzo host environment:</p>
                      <ul>
                        {[
                          'MITZO_BACKUP_ROOT',
                          'MITZO_BACKUP_ICLOUD_DIRECTORY',
                          'MITZO_BACKUP_RESTIC_BINARY',
                          'MITZO_BACKUP_UPLOAD_PROBE',
                        ].map((name) => (
                          <li key={name}>
                            <code>{name}</code>
                          </li>
                        ))}
                      </ul>
                      <p className="workspace-muted">
                        Keep the local repository outside iCloud Drive and outside the data being
                        backed up. The local folder must be owned by the operator with permissions
                        0700.
                      </p>
                    </>
                  )}
                  {setupStep === 1 && (
                    <>
                      <h4>Keep a recovery copy</h4>
                      <p>
                        Create a backup password and keep an independent copy you can retrieve after
                        losing this Mac.
                      </p>
                      <p>
                        In Keychain Access, add the same password as a generic password with service{' '}
                        <code>mitzo.backup</code> and account <code>repository</code>.
                      </p>
                      <p>
                        Once you have checked access to the independent copy, set{' '}
                        <code>MITZO_BACKUP_RECOVERY_CONFIRMED=true</code> in the host environment.
                        Keep passwords out of chat and configuration files.
                      </p>
                    </>
                  )}
                  {setupStep === 2 && (
                    <>
                      <h4>Check the configured service</h4>
                      <p>
                        Have the host configuration applied through Mitzo’s deployment process, then
                        check setup again here. Once ready, run a backup and verify its iCloud
                        upload.
                      </p>
                      <p className="workspace-muted">
                        Before relying on it, restore an independently downloaded iCloud copy in a
                        disposable environment. A successful upload alone does not prove recovery.
                      </p>
                    </>
                  )}
                </div>
                <div className="backup-controls">
                  {setupStep > 0 && (
                    <button onClick={() => setSetupStep(setupStep - 1)}>Previous</button>
                  )}
                  {setupStep < 2 ? (
                    <button
                      className="workspace-primary"
                      onClick={() => setSetupStep(setupStep + 1)}
                    >
                      Continue
                    </button>
                  ) : (
                    <button className="workspace-primary" onClick={() => void load()}>
                      Check setup again
                    </button>
                  )}
                  <button onClick={() => setSetupOpen(false)}>Close guide</button>
                </div>
                {setupStep !== 2 && (
                  <button className="backup-text-button" onClick={() => void load()}>
                    Check setup again
                  </button>
                )}
              </section>
            )}
          </section>
          {controls}
          <dl className="backup-summary">
            <div>
              <dt>Last verified local capture</dt>
              <dd>{date(view.lastCapture) ?? 'No verified capture'}</dd>
            </div>
            <div>
              <dt>Last confirmed iCloud upload</dt>
              <dd>{date(view.lastCloudUpload) ?? 'No confirmed upload'}</dd>
            </div>
            <div>
              <dt>Latest exported repository</dt>
              <dd>
                {latestExport?.bytes !== undefined ? bytes(latestExport.bytes) : 'No export yet'}
              </dd>
            </div>
          </dl>
          {view.busy && (
            <p role="status">
              Backup storage is busy. A running or retained writer lock prevents another backup.
            </p>
          )}
          <section className="today-section backup-panel" aria-label="Backup scope">
            <h2>Coverage</h2>
            <p className="workspace-muted">
              Partial ecosystem coverage. Only the included databases are captured.
            </p>
            <ul className="backup-coverage">
              {view.coverage.map((store) => (
                <li key={store.name}>
                  <div>
                    <strong>{store.name}</strong>
                    <span className="backup-badge">
                      {store.supported ? 'Included in capture' : 'Not included'}
                    </span>
                  </div>
                  <p className="workspace-muted">{store.detail}</p>
                </li>
              ))}
            </ul>
          </section>
          <section className="today-section backup-panel">
            <h2>Recent runs</h2>
            {view.runs.length === 0 ? (
              <p className="workspace-muted">No backups have run yet.</p>
            ) : (
              <ol className="backup-runs">
                {view.runs.map((run) => (
                  <li key={run.id}>
                    <div>
                      <strong>{labels[run.status]}</strong>
                      <time dateTime={run.startedAt}>{date(run.startedAt)}</time>
                    </div>
                    {run.error && <p className="backup-error">{run.error}</p>}
                    {run.cloudVerifiedAt && (
                      <p className="workspace-muted">Upload verified {date(run.cloudVerifiedAt)}</p>
                    )}
                    {run.status === 'pending' && (
                      <p className="workspace-muted">
                        Encrypted files are exported locally. iCloud has not confirmed every file is
                        uploaded.
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>
          <details className="backup-details backup-panel">
            <summary>Scheduling, retention and recovery</summary>
            <p>
              Backups are manual. Scheduling and retention are not enabled. Recovery still needs a
              rehearsal from an independently downloaded iCloud copy.
            </p>
          </details>
        </>
      )}
    </main>
  );
}
