import { useEffect, useRef, useState } from 'react';
import type { BackupSetupOverview } from '@mitzo/protocol';
import { configureBackups, getBackupSetup, prepareBackups } from '../lib/backups-api';

export function BackupSetup({
  onConfigured,
  onClose,
}: {
  onConfigured: () => void | Promise<void>;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<BackupSetupOverview>();
  const [password, setPassword] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(false);
  const sending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    void getBackupSetup()
      .then((value) => {
        if (mounted.current) setStatus(value);
      })
      .catch(() => {
        if (mounted.current) setError('Backup setup unavailable. Close and reopen setup to retry.');
      });
    return () => {
      mounted.current = false;
    };
  }, []);
  const act = async (kind: 'prepare' | 'configure') => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError('');
    const supplied = password;
    setPassword('');
    try {
      const next = kind === 'prepare' ? await prepareBackups() : await configureBackups(supplied);
      if (mounted.current) {
        setStatus(next);
        if (next.configured) await onConfigured();
      }
    } catch (error) {
      if (mounted.current)
        setError(error instanceof Error ? error.message : 'Backup setup did not complete. Retry.');
    } finally {
      sending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const step = status?.configured ? 2 : status?.prepared ? 1 : 0;
  return (
    <section id="backup-setup" className="backup-setup" aria-label="Backup setup">
      <h3>{status?.configured ? 'Backup setup complete' : 'Set up backups'}</h3>
      <ol className="backup-steps" aria-label="Setup progress">
        {['Storage', 'Password and recovery', 'Ready'].map((label, index) => (
          <li key={label} aria-current={step === index ? 'step' : undefined}>
            <span>{index + 1}</span>
            {label}
          </li>
        ))}
      </ol>
      {error && (
        <p role="alert" className="backup-error">
          {error}
        </p>
      )}
      {status?.busy && !busy && (
        <p role="status">
          Backup setup is running or has retained a safety lock. Check the Mac before continuing.
        </p>
      )}
      {!status && !error && <p role="status">Checking the Mac running Mitzo…</p>}
      {status && !status.supported && (
        <p>
          Backup setup requires the Mac running Mitzo. iCloud backups are unavailable on this host.
        </p>
      )}
      {status?.supported && (
        <div className="backup-step-content">
          {step === 0 && (
            <>
              <h4>Prepare your iCloud backup destination</h4>
              <p>
                Mitzo will create a private local repository and a dedicated iCloud folder. It will
                download a verified Restic encryption tool and prepare its iCloud upload helper on
                this Mac.
              </p>
              <dl className="backup-storage">
                <dt>Private local storage</dt>
                <dd>{status.localFolder}</dd>
                <dt>iCloud Drive destination</dt>
                <dd>{status.cloudFolder}</dd>
              </dl>
              <p className="workspace-muted">
                Preparation does not capture your data. Backups cover Mitzo and Telos databases;
                other stores remain outside this backup.
              </p>
              <button
                className="workspace-primary"
                disabled={busy || status.busy}
                onClick={() => void act('prepare')}
              >
                {busy ? 'Preparing storage and tools…' : 'Prepare storage'}
              </button>
            </>
          )}
          {step === 1 && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (password.length >= 16 && recovery && !busy) void act('configure');
              }}
            >
              <h4>Keep your recovery password in Apple Passwords</h4>
              <p>
                Create an entry called <strong>Mitzo backup recovery</strong> in Apple Passwords, or
                your preferred password manager. Generate a unique password of at least 16
                characters, save it, and paste it below.
              </p>
              <p>
                Mitzo stores the same password in this Mac’s Keychain for encryption. It never
                returns the password to the dashboard or sends it to an agent.
              </p>
              <label className="backup-password">
                Backup password
                <input
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  disabled={busy}
                  minLength={16}
                  maxLength={4096}
                  required
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              <label className="backup-recovery">
                <input
                  type="checkbox"
                  checked={recovery}
                  disabled={busy}
                  onChange={(event) => setRecovery(event.target.checked)}
                />
                <span>
                  I saved this password and checked I can retrieve it on another device without this
                  Mac.
                </span>
              </label>
              <button
                className="workspace-primary"
                type="submit"
                disabled={busy || status.busy || !recovery || password.length < 16}
              >
                {busy ? 'Saving securely…' : 'Finish setup'}
              </button>
            </form>
          )}
          {step === 2 && (
            <>
              <h4>Your backup destination is ready</h4>
              <p>
                Select “Back up now” to create your first encrypted backup. Then check its iCloud
                upload status.
              </p>
              <p className="workspace-muted">
                A confirmed upload still needs a restore rehearsal before you rely on it for
                recovery.
              </p>
              <button disabled={busy || status.busy} onClick={() => void act('prepare')}>
                {busy ? 'Refreshing backup tools…' : 'Refresh backup tools'}
              </button>
            </>
          )}
        </div>
      )}
      <div className="backup-controls">
        <button
          disabled={busy}
          onClick={() => {
            setPassword('');
            onClose();
          }}
        >
          {step === 2 ? 'Done' : 'Cancel setup'}
        </button>
      </div>
    </section>
  );
}
