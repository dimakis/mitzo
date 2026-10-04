import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { apiFetch } from '../lib/api-fetch';
import { downloadFile, shareTelosArtifact } from '../lib/share-file';
import { UserOutputUpload } from './UserOutputUpload';
import type { TodoOutput } from '../types/todo';

/** Browse durable output bytes even after the producing agent and sandbox are gone. */
export function WorkOutputs({ itemId, profile }: { itemId: string; profile?: string }) {
  const [result, setResult] = useState<{
    itemId: string;
    artifacts: TodoOutput[];
    limit: number;
    error?: string;
  } | null>(null);
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setResult(null);
    setActionError(null);
    apiFetch(`/api/telos/items/${encodeURIComponent(itemId)}/artifacts`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Unable to load saved outputs.');
        return response.json() as Promise<{ artifacts: TodoOutput[]; limit: number }>;
      })
      .then((data) => {
        if (!controller.signal.aborted) setResult({ itemId, ...data });
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setResult({ itemId, artifacts: [], limit: 100, error: 'Unable to load saved outputs.' });
        }
      });
    return () => controller.abort();
  }, [itemId, retry]);

  async function open(output: TodoOutput, action: 'download' | 'share') {
    if (busy) return;
    setBusy(output.id);
    setActionError(null);
    try {
      if (action === 'download') await downloadFile(output.url);
      else await shareTelosArtifact(output.url);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to open this output.');
    } finally {
      setBusy(null);
    }
  }

  const current = result?.itemId === itemId ? result : null;
  return (
    <section className="todo-detail-contract todo-detail-outputs" aria-label="Outputs">
      <div className="output-section-heading">
        <div>
          <h2>Outputs</h2>
          <p>
            {!current
              ? 'Loading saved files…'
              : current.error
                ? 'Saved files unavailable'
                : `${current.artifacts.length} saved file${current.artifacts.length === 1 ? '' : 's'}`}
          </p>
        </div>
        {!/^life[-_ ]?ops$/i.test(profile ?? '') && (
          <UserOutputUpload
            key={itemId}
            itemId={itemId}
            onUploaded={() => setRetry((value) => value + 1)}
          />
        )}
      </div>
      {/^life[-_ ]?ops$/i.test(profile ?? '') && (
        <p className="output-storage-note">
          LifeOps documents require private case storage. Shared output upload is unavailable.
        </p>
      )}
      {!current ? (
        <p role="status">Loading saved outputs…</p>
      ) : current.error ? (
        <div role="alert">
          <p>{current.error}</p>
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            Retry
          </button>
        </div>
      ) : current.artifacts.length === 0 ? (
        <p>No saved outputs yet.</p>
      ) : (
        <>
          <ul className="todo-detail-output-list">
            {current.artifacts.map((output) => (
              <li key={output.id}>
                <span className="output-file-icon" aria-hidden="true">
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  >
                    <path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" />
                    <path d="M14 3v5h5M8 13h8M8 17h5" />
                  </svg>
                </span>
                <div className="output-row-copy">
                  <strong>{output.title}</strong>
                  <span className="todo-detail-output-filename">{output.filename}</span>
                  <span className="todo-detail-output-meta">
                    Revision {output.revision} · {output.size.toLocaleString()} bytes
                    {output.sourceKind === 'user_upload' && ' · Uploaded by user'}
                    {output.sourceKind === 'external_codex_report' && ' · External Codex report'}
                  </span>
                </div>
                <div className="todo-detail-output-actions">
                  {!Capacitor.isNativePlatform() && (
                    <button
                      type="button"
                      className="output-action"
                      disabled={busy !== null}
                      aria-label={`Download ${output.title}`}
                      onClick={() => void open(output, 'download')}
                    >
                      Download
                    </button>
                  )}
                  <button
                    type="button"
                    className="output-action"
                    disabled={busy !== null}
                    aria-label={`Share ${output.title}`}
                    onClick={() => void open(output, 'share')}
                  >
                    Share
                  </button>
                  {busy === output.id && <span role="status">Preparing…</span>}
                </div>
              </li>
            ))}
          </ul>
          {current.artifacts.length >= current.limit && (
            <p>Showing the latest {current.limit} saved outputs.</p>
          )}
        </>
      )}
      {actionError && <p role="alert">{actionError}</p>}
    </section>
  );
}
