import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../lib/api-fetch';
import type { SourcePreview, SourceStatus } from '../types/symposium-source';
const confirmation = 'IMPORT COMMITTED REPOSITORY HISTORY';
async function read<T>(url: string, body?: unknown, csrf?: string): Promise<T> {
  const response = await apiFetch(
    url,
    body === undefined
      ? undefined
      : {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(csrf ? { 'x-csrf-token': csrf } : {}),
          },
          body: JSON.stringify(body),
        },
  );
  const value = await response.json();
  if (!response.ok) throw Error(value.error || 'Source operation failed');
  return value as T;
}
export function SymposiumSourceImportPanel({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false),
    [status, setStatus] = useState<SourceStatus | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const [repositoryId, setRepository] = useState(''),
    [targetRepository, setTarget] = useState(''),
    [baseBranch, setBase] = useState(''),
    [featureBranch, setFeature] = useState('');
  const [preview, setPreview] = useState<SourcePreview | null>(null),
    [passphrase, setPassphrase] = useState(''),
    [typed, setTyped] = useState('');
  const active = useRef(true);
  const operation = useRef('');
  const base = `/api/sessions/${encodeURIComponent(sessionId)}/symposium/source`;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, [sessionId]);
  async function refresh() {
    try {
      const next = await read<SourceStatus>(base);
      if (active.current) setStatus(next);
    } catch (cause) {
      if (active.current)
        setError(cause instanceof Error ? cause.message : 'Source status unavailable');
    }
  }
  function changed() {
    setPreview(null);
    setTyped('');
    setPassphrase('');
    setMessage('');
  }
  async function inspect() {
    setBusy(true);
    setError('');
    changed();
    try {
      const value = await read<SourcePreview>(base + '/preview', {
        repositoryId,
        targetRepository,
        baseBranch,
        featureBranch,
      });
      if (active.current) {
        setPreview(value);
        operation.current = globalThis.crypto.randomUUID();
      }
    } catch (cause) {
      if (active.current)
        setError(cause instanceof Error ? cause.message : 'Source preview unavailable');
    } finally {
      if (active.current) setBusy(false);
    }
  }
  async function apply() {
    if (!preview || busy || !passphrase || typed !== confirmation) return;
    const secret = passphrase;
    setPassphrase('');
    setTyped('');
    setBusy(true);
    setError('');
    try {
      const auth = await read<{ csrf: string; expiresAt: number }>(base + '/reauthorize', {
        passphrase: secret,
      });
      if (!active.current) return;
      if (!auth.csrf || !Number.isFinite(auth.expiresAt) || auth.expiresAt <= Date.now())
        throw Error('Recent app authorization expired. Enter the passphrase again.');
      await read(
        base + '/import',
        {
          plan: preview.plan,
          expectedRevision: preview.expectedRevision,
          expectedGeneration: preview.expectedGeneration,
          operationId: operation.current,
          confirmation,
        },
        auth.csrf,
      );
      if (active.current) {
        setPreview(null);
        setMessage(
          'Committed source imported. Seat admission and publication require separate actions.',
        );
        await refresh();
      }
    } catch (cause) {
      if (active.current) {
        setError(cause instanceof Error ? cause.message : 'Source import failed');
        await refresh();
      }
    } finally {
      if (active.current) setBusy(false);
    }
  }
  return (
    <section aria-label="Local repository source">
      <button
        type="button"
        onClick={() => {
          setOpen(!open);
          if (!open) void refresh();
        }}
      >
        Import local repository
      </button>
      {open && (
        <>
          {error && <p role="alert">{error}</p>}
          {message && <p role="status">{message}</p>}
          {!status ? (
            <p>Loading source readiness…</p>
          ) : !status.artifact?.available ? (
            <p>
              {status.artifact?.state === 'imported'
                ? 'Committed source has already been imported.'
                : status.artifact?.admissionIssued
                  ? 'Source import is unavailable because admission permission was already issued.'
                  : 'Source import is unavailable. An unused initialized volume with current host custody is required; an incomplete import cannot be retried automatically.'}
            </p>
          ) : (
            <fieldset disabled={busy}>
              <p>
                Import committed history from one configured local repository before seat admission.
                The local base may differ from GitHub: this action does not fetch. Limit: 8 MiB
                bundle and 64 MiB expanded history. Unsupported paths or known credentials are
                rejected.
              </p>
              <label>
                Configured local repository
                <select
                  value={repositoryId}
                  onChange={(e) => {
                    changed();
                    setRepository(e.target.value);
                  }}
                >
                  <option value="">Select repository</option>
                  {(status.repositories ?? []).map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                GitHub owner/repository
                <input
                  value={targetRepository}
                  onChange={(e) => {
                    changed();
                    setTarget(e.target.value);
                  }}
                />
              </label>
              <label>
                Local default base branch
                <input
                  value={baseBranch}
                  onChange={(e) => {
                    changed();
                    setBase(e.target.value);
                  }}
                />
              </label>
              <label>
                New feature branch
                <input
                  value={featureBranch}
                  onChange={(e) => {
                    changed();
                    setFeature(e.target.value);
                  }}
                />
              </label>
              <button
                type="button"
                disabled={
                  busy || !repositoryId || !targetRepository || !baseBranch || !featureBranch
                }
                onClick={() => void inspect()}
              >
                Preview committed source
              </button>
              {preview && (
                <>
                  <p>{preview.disclosure}</p>
                  <p>
                    Local base commit: <code>{preview.plan.baseOid}</code>; reachable commits:{' '}
                    {preview.plan.historyCommits}. Destination: {preview.plan.targetRepository},
                    branch {preview.plan.featureBranch}.
                  </p>
                  <label>
                    App passphrase for source import
                    <input
                      type="password"
                      autoComplete="current-password"
                      value={passphrase}
                      onChange={(e) => setPassphrase(e.target.value)}
                    />
                  </label>
                  <label>
                    Type {confirmation}
                    <input value={typed} onChange={(e) => setTyped(e.target.value)} />
                  </label>
                  <button
                    type="button"
                    disabled={busy || !passphrase || typed !== confirmation}
                    onClick={() => void apply()}
                  >
                    Import approved history
                  </button>
                </>
              )}
            </fieldset>
          )}
        </>
      )}
    </section>
  );
}
