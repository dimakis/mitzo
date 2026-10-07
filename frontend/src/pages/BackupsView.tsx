import { Link } from 'react-router-dom';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BackupOverview, BackupRunStatus } from '@mitzo/protocol';
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
  const latestExport = view?.runs.find((run) => run.bytes !== undefined);
  return (
    <main className="workspace-page backups-page">
      <Link className="workspace-text-link" to="/settings">
        ← Settings
      </Link>
      <WorkspacePageHeading
        title="Backups"
        description="Encrypted backups to your iCloud storage."
      />
      <div className="backup-controls">
        <button
          className="backup-primary"
          disabled={blocked}
          onClick={() => {
            void action('run');
          }}
        >
          Back up now
        </button>
        <button
          disabled={blocked || !view?.runs.some((r) => r.status === 'pending')}
          onClick={() => {
            void action('refresh');
          }}
        >
          Check iCloud upload
        </button>
        <button
          disabled={submitting}
          onClick={() => {
            void load();
          }}
        >
          Refresh status
        </button>
      </div>
      {error && (
        <p role="alert" className="backup-error">
          {error}
        </p>
      )}
      {!view && !error && <p role="status">Loading backup status…</p>}
      {view && (
        <>
          <section className="backup-notice" aria-label="Backup scope">
            <h2>{view.ready ? 'Partial ecosystem coverage' : 'Setup required'}</h2>
            <p>
              Manual backups currently cover the Mitzo and Telos database group. Other ecosystem
              data is still uncovered.
            </p>
            {view.setup.length > 0 && (
              <ul>
                {view.setup.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ul>
            )}
            <p>
              Scheduling and retention are not enabled. Recovery still needs a rehearsal from an
              independently downloaded iCloud copy.
            </p>
          </section>
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
          <section className="today-section">
            <h2>Coverage</h2>
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
          <section className="today-section">
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
        </>
      )}
    </main>
  );
}
