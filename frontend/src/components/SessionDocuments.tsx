import { useEffect, useRef, useState } from 'react';
import {
  SessionDocumentSchema,
  type SessionDocument,
  type SessionOutputCandidate,
} from '@mitzo/protocol';
import {
  documentBase,
  documentCatalog,
  documentJson,
  documentPreview,
  documentPage,
  readDocumentVersions,
  keepDocument,
  type DocumentCatalog,
  type DocumentPreview,
} from '../lib/session-documents-api';
import { apiFetch } from '../lib/api-fetch';
import { UiIcon } from './UiIcon';
import { SavedArtifactDialog } from './SavedArtifactDialog';
import { Capacitor } from '@capacitor/core';
import { shareNativeFile } from '../lib/native-file-share';
import './SessionDocuments.css';

type Selection = {
  sessionId: string;
  title: string;
  preview?: DocumentPreview;
  saved?: SessionDocument;
  content?: string | null;
  versions?: SessionDocument[];
  versionsBefore?: number | null;
};
/** Files and durable copies use the same host contract on every provider and account. */
export function SessionDocuments({
  sessionId,
  drafts,
  refreshKey,
  onRefresh,
}: {
  sessionId: string;
  drafts: SessionOutputCandidate[];
  refreshKey: number;
  onRefresh?: () => void;
}) {
  const [catalog, setCatalog] = useState<{ sessionId: string; value: DocumentCatalog } | null>(
    null,
  );
  const [telosSelection, setTelosSelection] = useState<{
    sessionId: string;
    artifact: DocumentCatalog['telos'][number];
  } | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [feedback, setFeedback] = useState<{
    sessionId: string;
    error?: string;
    busy?: boolean;
  } | null>(null);
  const [attempt, setAttempt] = useState(0),
    [page, setPage] = useState(0);
  const [draftSelection, setDraftSelection] = useState<{
    sessionId: string;
    candidate: SessionOutputCandidate;
  } | null>(null);
  const [path, setPath] = useState(''),
    [title, setTitle] = useState('');
  const active = useRef(sessionId);
  active.current = sessionId;
  const operation = useRef(0);
  const openerKey = useRef<string | null>(null);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const previewHeading = useRef<HTMLHeadingElement | null>(null);
  const value = catalog?.sessionId === sessionId ? catalog.value : null;
  const selected = selection?.sessionId === sessionId ? selection : null;
  const state = feedback?.sessionId === sessionId ? feedback : null;
  const base = documentBase(sessionId);
  const selectedDraft =
    draftSelection?.sessionId === sessionId ? draftSelection.candidate : drafts[0];
  const draftKey = (draft: SessionOutputCandidate) => JSON.stringify(draft.source);
  const draftOptions =
    selectedDraft && !drafts.some((draft) => draftKey(draft) === draftKey(selectedDraft))
      ? [selectedDraft, ...drafts]
      : drafts;

  useEffect(() => {
    if (selected) previewHeading.current?.focus({ preventScroll: true });
    else returnFocus.current?.focus({ preventScroll: true });
  }, [selected]);
  useEffect(() => {
    setSelection(null);
    setPage(0);
    setPath('');
    setTitle('');
    setDraftSelection(null);
    return () => {
      operation.current = -1;
    };
  }, [sessionId]);
  useEffect(() => {
    const controller = new AbortController();
    void documentJson(base, { signal: controller.signal })
      .then((body) => {
        const value = documentCatalog.parse(body);
        if (value.saved.some((document) => document.sessionId !== sessionId))
          throw Error('Document conversation changed.');
        if (!controller.signal.aborted) setCatalog({ sessionId, value });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setFeedback({
            sessionId,
            error: error instanceof Error ? error.message : 'Documents could not be checked.',
          });
      });
    return () => controller.abort();
  }, [base, sessionId, attempt, refreshKey]);
  async function run(action: () => Promise<void>) {
    const seq = ++operation.current;
    setFeedback({ sessionId, busy: true });
    try {
      await action();
      if (active.current === sessionId && operation.current === seq) setFeedback({ sessionId });
    } catch (error) {
      if (active.current === sessionId && operation.current === seq)
        setFeedback({
          sessionId,
          error: error instanceof Error ? error.message : 'Document unavailable. Retry.',
        });
    }
  }
  async function inspect(path: string, title: string) {
    await run(async () => {
      const preview = documentPreview.parse(
        await documentJson(`${base}/preview`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path }),
        }),
      );
      if (active.current === sessionId)
        setSelection({ sessionId, title, preview, content: preview.content });
    });
  }
  async function inspectSaved(document: SessionDocument) {
    await run(async () => {
      const body = await documentJson(`${base}/saved/${document.id}?revision=${document.revision}`);
      const received = SessionDocumentSchema.parse(body.document);
      if (
        received.id !== document.id ||
        received.sessionId !== sessionId ||
        received.revision !== document.revision ||
        received.sha256 !== document.sha256
      )
        throw Error('Saved version changed. Refresh the list.');
      const retained = selected?.saved?.id === document.id ? selected : undefined;
      const rows = retained?.versions ?? (await readDocumentVersions(sessionId, document.id));
      const versionsBefore = retained?.versions
        ? retained.versionsBefore
        : (rows.at(-1)?.revision ?? 1) > 1
          ? rows.at(-1)!.revision
          : null;
      const versions = [
        ...new Map([...rows, received].map((row) => [row.revision, row])).values(),
      ].sort((a, b) => b.revision - a.revision);
      if (active.current === sessionId)
        setSelection({
          sessionId,
          title: document.title,
          saved: received,
          content: body.content,
          versions,
          versionsBefore,
        });
    });
  }
  async function loadEarlierVersions() {
    if (!selected?.saved || !selected.versionsBefore) return;
    const id = selected.saved.id,
      before = selected.versionsBefore;
    await run(async () => {
      const earlier = await readDocumentVersions(sessionId, id, before);
      if (active.current === sessionId)
        setSelection((old) =>
          old?.saved?.id === id
            ? {
                ...old,
                versions: [
                  ...new Map(
                    [...(old.versions ?? []), ...earlier].map((row) => [row.revision, row]),
                  ).values(),
                ].sort((a, b) => b.revision - a.revision),
                versionsBefore:
                  (earlier.at(-1)?.revision ?? 1) > 1 ? earlier.at(-1)!.revision : null,
              }
            : old,
        );
    });
  }
  async function loadOlderDocuments() {
    if (!value?.savedCursor) return;
    await run(async () => {
      const next = documentPage.parse(
        await documentJson(
          `${base}/saved?before=${encodeURIComponent(JSON.stringify(value.savedCursor))}`,
        ),
      );
      const last = next.documents.at(-1);
      if (
        next.documents.some((row) => row.sessionId !== sessionId) ||
        next.hasMore !== !!next.cursor ||
        (next.cursor &&
          (!last || next.cursor.id !== last.id || next.cursor.createdAt !== last.createdAt))
      )
        throw Error('Saved document history changed. Refresh the list.');
      if (active.current === sessionId) {
        setCatalog((old) =>
          old?.sessionId === sessionId
            ? {
                sessionId,
                value: {
                  ...old.value,
                  saved: [
                    ...new Map(
                      [...old.value.saved, ...next.documents].map((row) => [row.id, row]),
                    ).values(),
                  ],
                  savedCursor: next.cursor,
                  savedHasMore: next.hasMore,
                },
              }
            : old,
        );
        setPage(Math.floor(value.saved.length / 8));
      }
    });
  }
  async function keep(title: string, source: Record<string, unknown>) {
    await run(async () => {
      const document = await keepDocument(sessionId, { title, source });
      if (active.current === sessionId) {
        setSelection((old) => ({
          sessionId,
          title,
          saved: document,
          content:
            source.kind === 'draft'
              ? selectedDraft?.content
              : old?.sessionId === sessionId
                ? old.content
                : undefined,
        }));
        setAttempt((value) => value + 1);
      }
    });
  }
  const rows = value
    ? [
        ...value.saved.map((document) => ({
          key: `saved:${document.id}`,
          title: document.title,
          label: `Saved · version ${document.revision}`,
          open: () => void inspectSaved(document),
        })),
        ...value.workspace.map((document) => ({
          key: `workspace:${document.path}`,
          title: document.title,
          label:
            document.evidence === 'created'
              ? 'Created in workspace · not kept'
              : 'Linked in chat · file not checked',
          open: () => void inspect(document.path, document.title),
        })),
      ]
    : [];
  const pageCount = Math.max(1, Math.ceil(rows.length / 8));
  const currentPage = Math.min(page, pageCount - 1);
  return (
    <section className="session-documents" aria-label="Documents">
      <h3>Documents</h3>
      <p className="workspace-muted">
        Keep a copy to preserve a document after its workspace is removed. No task is required.
      </p>
      {state?.busy && <p role="status">Checking document…</p>}
      {state?.error && <p role="alert">{state.error}</p>}
      {selected ? (
        <>
          <button
            className="home-secondary"
            disabled={state?.busy}
            onClick={() => setSelection(null)}
          >
            <UiIcon name="back" size={16} /> Back to documents
          </button>
          <h4 tabIndex={-1} ref={previewHeading}>
            {selected.title}
          </h4>
          <p>
            {selected.saved
              ? `Saved · version ${selected.saved.revision}`
              : 'In workspace · not kept'}
          </p>
          {selected.preview && (
            <p className="workspace-muted">
              {selected.preview.filename} · {selected.preview.size} bytes
            </p>
          )}
          <div className="home-inline-actions">
            {selected.preview && !selected.saved && (
              <button
                className="home-primary"
                disabled={state?.busy}
                onClick={() =>
                  void keep(selected.title, {
                    kind: 'file',
                    path: selected.preview!.path,
                    sha256: selected.preview!.sha256,
                  })
                }
              >
                Keep a copy
              </button>
            )}
            {selected.saved && (
              <button
                className="home-secondary"
                disabled={state?.busy}
                onClick={() =>
                  void run(async () => {
                    const savedDocument = selected.saved!;
                    const response = await apiFetch(
                      `${base}/saved/${savedDocument.id}/download?revision=${savedDocument.revision}`,
                    );
                    if (!response.ok) throw Error('Download unavailable. Retry.');
                    const blob = await response.blob();
                    if (active.current !== sessionId) return;
                    const file = new File([blob], savedDocument.filename, { type: blob.type });
                    if (Capacitor.isNativePlatform()) await shareNativeFile(file);
                    else if (navigator.canShare?.({ files: [file] }))
                      await navigator.share({ files: [file] });
                    else {
                      const url = URL.createObjectURL(blob),
                        link = document.createElement('a');
                      link.href = url;
                      link.download = file.name;
                      link.click();
                      setTimeout(() => URL.revokeObjectURL(url), 1000);
                    }
                  })
                }
              >
                Download
              </button>
            )}
          </div>
          {selected.versions && selected.versions.length > 1 && (
            <label>
              Saved version
              <select
                aria-label="Saved version"
                value={selected.saved?.revision}
                disabled={state?.busy}
                onChange={(event) => {
                  const version = selected.versions!.find(
                    (row) => row.revision === Number(event.target.value),
                  );
                  if (version) void inspectSaved(version);
                }}
              >
                {selected.versions.map((version) => (
                  <option key={version.revision} value={version.revision}>
                    Version {version.revision}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!!selected.versionsBefore && (
            <button
              className="home-secondary"
              disabled={state?.busy}
              onClick={() => void loadEarlierVersions()}
            >
              Load earlier versions
            </button>
          )}
          {selected.content !== undefined &&
            (selected.content === null ? (
              <p>Preview unavailable. Keep or download the original file.</p>
            ) : (
              <pre className="session-document-content">{selected.content}</pre>
            ))}
        </>
      ) : (
        <>
          {!value && !state?.error && <p role="status">Loading documents…</p>}
          {value && !rows.length && !value.telos.length && <p>No documents found yet.</p>}
          {rows.slice(currentPage * 8, currentPage * 8 + 8).map((row) => (
            <div className="chat-resource-row" key={row.key}>
              <UiIcon name="file" />
              <button
                disabled={state?.busy}
                aria-label={`Preview ${row.title}`}
                ref={(element) => {
                  if (row.key === openerKey.current) returnFocus.current = element;
                }}
                onClick={() => {
                  openerKey.current = row.key;
                  row.open();
                }}
              >
                <strong>{row.title}</strong>
                <small>{row.label}</small>
              </button>
              <UiIcon name="forward" size={16} />
            </div>
          ))}
          {pageCount > 1 && (
            <div className="home-inline-actions">
              <button
                className="home-secondary"
                disabled={!currentPage}
                onClick={() => setPage(currentPage - 1)}
              >
                Previous documents
              </button>
              <span>
                {currentPage + 1} / {pageCount}
              </span>
              <button
                className="home-secondary"
                disabled={currentPage === pageCount - 1}
                onClick={() => setPage(currentPage + 1)}
              >
                Next documents
              </button>
            </div>
          )}
          {value?.savedHasMore && (
            <button
              className="home-secondary"
              disabled={state?.busy}
              onClick={() => void loadOlderDocuments()}
            >
              Load older saved documents
            </button>
          )}
          {!!value?.telos.length && <h4>Saved in Work</h4>}
          {value?.telos.map((document) => (
            <div className="chat-resource-row" key={`${document.id}:${document.revision}`}>
              <UiIcon name="file" />
              <button onClick={() => setTelosSelection({ sessionId, artifact: document })}>
                <strong>{document.title}</strong>
                <small>Saved in Work · version {document.revision}</small>
              </button>
            </div>
          ))}
          {value?.telosError && <p role="alert">{value.telosError}</p>}
          {value?.telosHasMore && <p>More historical documents are available in Work.</p>}
          <details>
            <summary>Keep another file</summary>
            <label>
              File path
              <input
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder="reports/report.md"
              />
            </label>
            <button
              className="home-secondary"
              disabled={!path.trim() || state?.busy}
              onClick={() => void inspect(path.trim(), path.split('/').pop() || 'Document')}
            >
              Preview file
            </button>
          </details>
          {!!draftOptions.length && (
            <details
              onToggle={(event) => {
                if (
                  event.currentTarget.open &&
                  selectedDraft &&
                  draftSelection?.sessionId !== sessionId
                )
                  setDraftSelection({ sessionId, candidate: selectedDraft });
              }}
            >
              <summary>Keep a chat response</summary>
              <label>
                Response
                <select
                  value={selectedDraft ? draftKey(selectedDraft) : ''}
                  onChange={(event) => {
                    const candidate = draftOptions.find(
                      (draft) => draftKey(draft) === event.target.value,
                    );
                    if (candidate) setDraftSelection({ sessionId, candidate });
                  }}
                >
                  {draftOptions.map((draft) => (
                    <option key={draftKey(draft)} value={draftKey(draft)}>
                      {draft.content.slice(0, 100)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Document title
                <input
                  value={title}
                  onChange={(event) => {
                    if (selectedDraft) setDraftSelection({ sessionId, candidate: selectedDraft });
                    setTitle(event.target.value);
                  }}
                  maxLength={190}
                />
              </label>
              <button
                className="home-secondary"
                disabled={!title.trim() || state?.busy || !selectedDraft}
                onClick={() => void keep(title.trim(), { kind: 'draft', ...selectedDraft!.source })}
              >
                Keep response
              </button>
            </details>
          )}
        </>
      )}
      <SavedArtifactDialog
        artifact={telosSelection?.sessionId === sessionId ? telosSelection.artifact : undefined}
        open={telosSelection?.sessionId === sessionId}
        onClose={() => setTelosSelection(null)}
      />
      <button
        className="home-secondary"
        disabled={state?.busy}
        onClick={() => {
          setFeedback(null);
          if (onRefresh) onRefresh();
          else setAttempt((value) => value + 1);
        }}
      >
        Refresh outputs
      </button>
    </section>
  );
}
