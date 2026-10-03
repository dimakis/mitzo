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
      <h2>Outputs</h2>
      {/^life[-_ ]?ops$/i.test(profile ?? '') ? (
        <p>LifeOps documents require private case storage. Shared output upload is unavailable.</p>
      ) : (
        <UserOutputUpload
          key={itemId}
          itemId={itemId}
          onUploaded={() => setRetry((value) => value + 1)}
        />
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
          <p className="todo-detail-output-note">Saved files. Review and delivery are separate.</p>
          <ul className="todo-detail-output-list">
            {current.artifacts.map((output) => (
              <li key={output.id}>
                <strong>{output.title}</strong>
                <span className="todo-detail-output-filename">{output.filename}</span>
                <span className="todo-detail-output-meta">
                  Revision {output.revision} · {output.size.toLocaleString()} bytes
                  {output.sourceKind === 'user_upload' && ' · Uploaded by user'}
                  {output.sourceKind === 'external_codex_report' && ' · External Codex report'}
                </span>
                <div className="todo-detail-output-actions">
                  {!Capacitor.isNativePlatform() && (
                    <button
                      type="button"
                      disabled={busy !== null}
                      aria-label={`Download ${output.title}`}
                      onClick={() => void open(output, 'download')}
                    >
                      Download
                    </button>
                  )}
                  <button
                    type="button"
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
