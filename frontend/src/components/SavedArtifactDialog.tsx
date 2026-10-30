import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
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
import { UiIcon } from './UiIcon';
import { HomeDialog } from './HomeDialog';
import { ShareButton } from './ShareButton';
import { HtmlPreview } from './HtmlPreview';
import { useMotionPresence } from '../hooks/useMotionPresence';
import { artifactViewerUrl } from '../lib/file-paths';
import './SavedArtifactDialog.css';

const PdfPreview = lazy(() =>
  import('./PdfPreview').then((module) => ({ default: module.PdfPreview })),
);

/** One modal owns loading, selected revision inspection and return focus. Files
 * remains the full editing surface, reached at this exact revision via File options.
 */
export function SavedArtifactDialog({
  artifact,
  onClose,
  open = true,
  error,
  onRetry,
  onVersionChange,
}: {
  artifact?: TodoOutput;
  onClose(): void;
  open?: boolean;
  error?: string;
  onRetry?(): void;
  onVersionChange?(artifact: SavedArtifactVersion): void;
}) {
  const { ref, present } = useMotionPresence(open, 'popover', false);
  if (!present) return null;
  return (
    <HomeDialog
      title={artifact?.title ?? 'Saved artifact'}
      onClose={onClose}
      className="saved-artifact-dialog"
      inactive={!open}
    >
      <div
        ref={ref}
        className="saved-artifact-surface"
        inert={!open}
        aria-hidden={!open || undefined}
      >
        {artifact ? (
          <SavedArtifactDetails
            key={`${artifact.itemId}:${artifact.id}`}
            artifact={artifact}
            open={open}
            onClose={onClose}
            onVersionChange={onVersionChange}
          />
        ) : (
          <>
            <div className="saved-artifact-body">
              {error ? (
                <div role="alert">
                  <p>{error}</p>
                  {onRetry && (
                    <button type="button" className="home-secondary" onClick={onRetry}>
                      Retry saved version
                    </button>
                  )}
                </div>
              ) : (
                <p role="status">Loading saved version…</p>
              )}
            </div>
            <footer>
              <button type="button" className="home-secondary" onClick={onClose}>
                Done
              </button>
            </footer>
          </>
        )}
      </div>
    </HomeDialog>
  );
}
function SavedArtifactDetails({
  artifact,
  onClose,
  open,
  onVersionChange,
}: {
  artifact: TodoOutput;
  onClose(): void;
  open: boolean;
  onVersionChange?(artifact: SavedArtifactVersion): void;
}) {
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
  const loadedPreview = useRef<string | null>(null);
  const [document, setDocument] = useState<{
    revision: number;
    document: SavedArtifactDocument | null;
    error: string | null;
  } | null>(null);
  const historyTarget = useRef(artifact);
  historyTarget.current = artifact;
  const navigate = useNavigate();
  const location = useLocation();
  const version = versions.find((row) => row.revision === selected)!;
  const url = savedArtifactUrl(version);
  const isPdf = version.filename.toLocaleLowerCase().endsWith('.pdf');
  useEffect(() => {
    if (!open) {
      setPageBefore(undefined);
      return;
    }
    const controller = new AbortController();
    setHistory((previous) => ({ ...previous, loaded: false, error: null }));
    readSavedArtifactVersions(historyTarget.current, controller.signal, pageBefore)
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
  }, [artifact.id, artifact.itemId, pageBefore, historyRetry, open]);
  useEffect(() => {
    if (!open) {
      loadedPreview.current = null;
      return;
    }
    const identity = JSON.stringify([version.id, selected, version.sha256, previewRetry]);
    if (!history.loaded || isPdf || loadedPreview.current === identity) return;
    const controller = new AbortController();
    setDocument(null);
    readSavedArtifactDocument(version, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          loadedPreview.current = identity;
          setDocument({ revision: selected, document: value, error: null });
        }
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
  }, [version, selected, history.loaded, previewRetry, open, isPdf]);
  const current = document?.revision === selected ? document : null;
  const preview = history.loaded && !history.error ? current?.document : null;
  const provenance = version as SavedArtifactVersion;
  return (
    <>
      <div className="saved-artifact-body">
        <p className="saved-artifact-kind">Saved artifact · Saved under Work</p>
        <label className="saved-artifact-version">
          <span>Version</span>
          <select
            aria-label="Version"
            value={selected}
            onChange={(event) => {
              const chosen = versions.find((row) => row.revision === Number(event.target.value));
              if (chosen) {
                setSelected(chosen.revision);
                onVersionChange?.(chosen);
              }
            }}
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
        {!history.error && (!history.loaded || (!isPdf && !current)) && (
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
        {isPdf && history.loaded && !history.error && (
          <Suspense fallback={<p role="status">Opening PDF reader…</p>}>
            <PdfPreview key={url} url={url} title={version.title} />
          </Suspense>
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
                  (url) => navigate(url, { state: location.state }),
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
        <Link
          className="home-secondary saved-artifact-work-link"
          to={`/todos/${encodeURIComponent(version.itemId)}`}
          state={location.state}
        >
          <span>Open Work item</span>
          <UiIcon name="forward" size={16} />
        </Link>
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
        {(preview || (isPdf && history.loaded && !history.error)) && (
          <ShareButton
            key={url}
            filePath={url}
            onOpen={() =>
              navigate(artifactViewerUrl(url, location.pathname + location.search), {
                state: location.state,
              })
            }
          />
        )}
        <button className="home-secondary" type="button" onClick={onClose}>
          Done
        </button>
      </footer>
    </>
  );
}
