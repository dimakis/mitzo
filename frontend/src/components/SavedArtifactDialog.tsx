import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import type { TodoOutput } from '../types/todo';
import type { SavedArtifactDocument, SavedArtifactVersion } from '../types/retained-artifact';
import {
  readSavedArtifactDocument,
  readSavedArtifactVersions,
  savedArtifactUrl,
} from '../lib/retained-artifact-api';
import {
  artifactMarkdownComponents,
  artifactUrlTransform,
  rehypePlugins,
  remarkPlugins,
} from '../lib/markdown-config';
import { HomeDialog } from './HomeDialog';
import { ShareButton } from './ShareButton';
import { HtmlPreview } from './HtmlPreview';
import { useMotionPresence } from '../hooks/useMotionPresence';
import './SavedArtifactDialog.css';

/** The caller supplies an explicit retained revision; newer history never retargets it. */
export function SavedArtifactDialog({
  artifact,
  onClose,
  open = true,
}: {
  artifact: TodoOutput;
  onClose(): void;
  open?: boolean;
}) {
  const { ref: motionRef, present } = useMotionPresence(open, 'popover', false);
  const [versions, setVersions] = useState<SavedArtifactVersion[]>([artifact]);
  const [selected, setSelected] = useState(artifact.revision);
  const [history, setHistory] = useState<{
    cursor: number | null;
    error: string | null;
    loaded: boolean;
  }>({ cursor: null, error: null, loaded: false });
  const [pageBefore, setPageBefore] = useState<number>();
  const [historyRetry, setHistoryRetry] = useState(0);
  const [previewRetry, setPreviewRetry] = useState(0);
  const [document, setDocument] = useState<{
    revision: number;
    document: SavedArtifactDocument | null;
    error: string | null;
  } | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const version = versions.find((row) => row.revision === selected)!;
  const url = savedArtifactUrl(version);
  useEffect(() => {
    if (!open) {
      setPageBefore(undefined);
      return;
    }
    const controller = new AbortController();
    setHistory((previous) => ({ ...previous, loaded: false, error: null }));
    readSavedArtifactVersions(artifact, controller.signal, pageBefore)
      .then((page) => {
        if (controller.signal.aborted) return;
        setVersions((previous) => {
          const rows = new Map(previous.map((row) => [row.revision, row]));
          for (const row of page.artifacts) rows.set(row.revision, row);
          return [...rows.values()].sort((a, b) => b.revision - a.revision);
        });
        setHistory({ cursor: page.cursor, error: null, loaded: true });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setHistory({
            cursor: pageBefore ?? null,
            error: error instanceof Error ? error.message : 'Saved history unavailable.',
            loaded: false,
          });
      });
    return () => controller.abort();
  }, [artifact, pageBefore, historyRetry, open]);
  useEffect(() => {
    if (!history.loaded || !open) return;
    const controller = new AbortController();
    setDocument(null);
    readSavedArtifactDocument(version, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted)
          setDocument({ revision: selected, document: value, error: null });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setDocument({
            revision: selected,
            document: null,
            error: error instanceof Error ? error.message : 'Saved preview unavailable.',
          });
      });
    return () => controller.abort();
  }, [version, selected, history.loaded, previewRetry, open]);
  const current = document?.revision === selected ? document : null;
  const preview = history.loaded && !history.error ? current?.document : null;
  const provenance = version as SavedArtifactVersion;
  if (!present) return null;
  return (
    <HomeDialog
      title={artifact.title}
      onClose={onClose}
      className="saved-artifact-dialog"
      inactive={!open}
    >
      <div
        ref={motionRef}
        className="saved-artifact-body"
        inert={!open}
        aria-hidden={!open || undefined}
      >
        <p className="saved-artifact-kind">Saved artifact · Saved under Work</p>
        <label className="saved-artifact-version">
          <span>Version</span>
          <select
            aria-label="Version"
            value={selected}
            onChange={(event) => setSelected(Number(event.target.value))}
          >
            {versions.map((row) => (
              <option key={row.revision} value={row.revision}>
                Saved version {row.revision}
                {row.revision === versions[0]?.revision ? ' · latest' : ''}
              </option>
            ))}
          </select>
          <small>
            A version is a saved change to this document, independent of chats and turns.
          </small>
        </label>
        {history.error && (
          <div role="alert">
            <p>{history.error}</p>
            <button
              className="home-secondary"
              type="button"
              onClick={() => setHistoryRetry((value) => value + 1)}
            >
              Retry history
            </button>
          </div>
        )}
        {history.cursor !== null && !history.error && (
          <button
            className="home-secondary"
            type="button"
            onClick={() => setPageBefore(history.cursor!)}
          >
            Earlier versions
          </button>
        )}
        {!history.error && (!history.loaded || !current) && (
          <p role="status">Loading saved version…</p>
        )}
        {current?.error && (
          <div role="alert">
            <p>{current.error}</p>
            <button
              className="home-secondary"
              type="button"
              onClick={() => setPreviewRetry((value) => value + 1)}
            >
              Retry preview
            </button>
          </div>
        )}
        {preview && (
          <div className="saved-artifact-preview">
            {preview.previewUnavailable ? (
              <p>{preview.content}</p>
            ) : ['.md', '.mdx'].includes(preview.ext) ? (
              <ReactMarkdown
                remarkPlugins={remarkPlugins}
                rehypePlugins={rehypePlugins}
                urlTransform={artifactUrlTransform}
                components={artifactMarkdownComponents(
                  url,
                  undefined,
                  location.pathname + location.search,
                  navigate,
                )}
              >
                {preview.content}
              </ReactMarkdown>
            ) : ['.html', '.htm'].includes(preview.ext) ? (
              <HtmlPreview html={preview.content} title={`${version.filename} preview`} />
            ) : (
              <pre>{preview.content}</pre>
            )}
          </div>
        )}
        <section aria-label="Sharing">
          <strong>Shared with</strong>
          <p>Delivery information is not recorded here.</p>
          <small>Saving under Work does not deliver content to every agent.</small>
        </section>
        <details>
          <summary>Provenance</summary>
          <dl>
            <dt>Filename</dt>
            <dd>{version.filename}</dd>
            <dt>Saved version</dt>
            <dd>{selected}</dd>
            <dt>Source</dt>
            <dd>
              {provenance.sourceKind === 'user_upload'
                ? 'Uploaded by user'
                : provenance.sourceKind === 'user_edit'
                  ? 'Edited by user'
                  : (provenance.sessionId ?? 'Not recorded')}
            </dd>
            {provenance.createdAt && (
              <>
                <dt>Saved</dt>
                <dd>{provenance.createdAt}</dd>
              </>
            )}
            <dt>Content hash</dt>
            <dd>{version.sha256}</dd>
          </dl>
          <p>Saved bytes remain distinct from discussion, publication and outcome completion.</p>
        </details>
      </div>
      <footer>
        {preview && <ShareButton key={url} filePath={url} />}
        <button className="home-secondary" type="button" onClick={onClose}>
          Done
        </button>
      </footer>
    </HomeDialog>
  );
}
