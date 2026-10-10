import { useRef, useState } from 'react';
import { KnowledgeTree } from '../components/KnowledgeTree';
import { KnowledgeReader } from '../components/KnowledgeReader';
import { KnowledgeOrganizationDialog } from '../components/KnowledgeOrganizationDialog';
import type { KnowledgeDocument, KnowledgeDraft } from '../types/knowledge';
import { DocumentEditor } from '../components/DocumentEditor';
import { WorkspacePageHeading } from '../components/WorkspacePageHeading';
import { useKnowledgeLibrary } from '../hooks/useKnowledgeLibrary';
function OrganizationChanges({
  directories = [],
  documents,
}: {
  directories?: string[];
  documents: KnowledgeDraft['documents'];
}) {
  const moves = documents.filter((document) => document.sourcePath);
  return (
    <>
      <h5>New folders</h5>
      {directories.length ? (
        <ul>
          {directories.map((path) => (
            <li key={path}>{path}</li>
          ))}
        </ul>
      ) : (
        <p>No new folders.</p>
      )}
      <h5>Document moves</h5>
      {moves.length ? (
        <ul>
          {moves.map((document) => (
            <li key={document.path}>
              {document.sourcePath} → {document.path}
            </li>
          ))}
        </ul>
      ) : (
        <p>No document moves.</p>
      )}
    </>
  );
}

export function KnowledgeLibrary() {
  const library = useKnowledgeLibrary();
  const { catalog, copy, selected, dirty, busy } = library;
  const [tab, setTab] = useState<'library' | 'drafts'>('library');
  const [search, setSearch] = useState('');
  const [area, setArea] = useState('All knowledge');
  const [reading, setReading] = useState(false);
  const [details, setDetails] = useState(false);
  const [adding, setAdding] = useState(false);
  const [reader, setReader] = useState<{ document: KnowledgeDocument; content: string }>();
  const readRequest = useRef(0);
  const [readerFailure, setReaderFailure] = useState<{
    document: KnowledgeDocument;
    message: string;
  }>();
  const [parent, setParent] = useState('');
  const [menu, setMenu] = useState<KnowledgeDocument>();
  const [dialog, setDialog] = useState<'folder' | 'move'>();
  const movedSources = new Set(
    copy?.documents.flatMap((document) => (document.sourcePath ? [document.sourcePath] : [])) || [],
  );
  const treeDocuments = [
    ...(catalog?.documents.filter((document) => !movedSources.has(document.path)) || []),
  ];
  for (const document of copy?.documents || []) {
    if (!treeDocuments.some((item) => item.path === document.path)) {
      const source = catalog?.documents.find(
        (item) => item.path === (document.sourcePath || document.path),
      );
      treeDocuments.push({
        path: document.path,
        title: source?.title || document.path.split('/').pop()!,
        area: source?.area || document.path.split('/')[0],
      });
    }
  }
  function showWorkingCopy() {
    ++readRequest.current;
    setReaderFailure(undefined);
    setReader(undefined);
    setReading(true);
  }
  async function openReader(document: KnowledgeDocument) {
    const request = ++readRequest.current;
    if (adding) {
      if ((await library.openDocument(document, true)) && request === readRequest.current) {
        showWorkingCopy();
        setAdding(false);
      }
      return;
    }
    setReaderFailure(undefined);
    try {
      const value = await library.readDocument(document);
      if (!value) throw new Error('Refresh the library and try again.');
      if (request === readRequest.current) {
        setReader({ document, content: value.content });
        setReading(false);
      }
    } catch (error: unknown) {
      if (request === readRequest.current) {
        setReaderFailure({
          document,
          message: error instanceof Error ? error.message : 'Please try again.',
        });
      }
    }
  }
  const areas = [...new Set(catalog?.documents.map((d) => d.area) || [])];
  const documents =
    treeDocuments.filter(
      (d) =>
        (area === 'All knowledge' || d.area === area) &&
        `${d.title} ${d.path}`.toLowerCase().includes(search.toLowerCase()),
    ) || [];
  const draft = copy?.draft;
  const editable = !draft || draft.state === 'draft' || draft.state === 'in-review';
  const closedEmpty =
    draft?.state === 'closed' && !copy?.documents.length && !copy?.directories?.length;
  const currentReview = !!draft?.review && draft.review.version === draft.version;
  const showEditor =
    !!copy &&
    reading &&
    !reader &&
    (!!selected || !!copy.directories?.length || !!copy.initialSaveConflict);
  const structureChanged =
    !!copy?.directories?.length || !!copy?.documents.some((document) => document.sourcePath);
  const areaRoots = new Set(
    (catalog?.documents || [])
      .filter((document) => area === 'All knowledge' || document.area === area)
      .map((document) => document.path.split('/')[0]),
  );
  const visibleDirectories = library.directories.filter(
    (directory) => area === 'All knowledge' || areaRoots.has(directory.split('/')[0]),
  );
  const folderParents = [
    ...new Set([
      ...library.directories,
      ...(catalog?.documentPaths || []).filter((scope) => library.canCreateInDirectory(scope)),
    ]),
  ];
  const editorComparisons = showEditor ? (
    <>
      {copy!.initialSaveConflict && (
        <section className="knowledge-comparison" aria-label="Compare saved draft and working copy">
          <h3>This saved draft changed on another device</h3>
          <p>
            Your working copy is preserved. Compare every document, new folder and document move
            before choosing which version to keep. Updating the saved draft replaces its contents
            and organization changes with your working copy.
          </p>
          {copy!.savedComparisonUnavailable && (
            <p>The latest saved version is unavailable. Refresh the comparison to continue.</p>
          )}
          <div className="knowledge-compare-panes">
            <section aria-label="Saved draft organization">
              <h4>Saved draft organization</h4>
              {copy!.savedComparisonUnavailable ? (
                <p>Awaiting latest saved version.</p>
              ) : (
                <OrganizationChanges
                  directories={copy!.initialSaveConflict.directories}
                  documents={copy!.initialSaveConflict.documents}
                />
              )}
            </section>
            <section aria-label="Your working copy organization">
              <h4>Your working copy organization</h4>
              <OrganizationChanges directories={copy!.directories} documents={copy!.documents} />
            </section>
          </div>
          {[
            ...new Set([
              ...copy!.initialSaveConflict.documents.map((d) => d.path),
              ...copy!.documents.map((d) => d.path),
            ]),
          ].map((path) => (
            <div key={path}>
              <h4>{path}</h4>
              <div className="knowledge-compare-panes">
                <div>
                  <h4>Saved draft</h4>
                  <pre>
                    {copy!.savedComparisonUnavailable
                      ? 'Awaiting latest saved version.'
                      : (copy!.initialSaveConflict!.documents.find((d) => d.path === path)
                          ?.content ?? 'Not in the saved draft.')}
                  </pre>
                </div>
                <div>
                  <h4>Your working copy</h4>
                  <pre>
                    {copy!.documents.find((d) => d.path === path)?.content ??
                      'Not in your working copy.'}
                  </pre>
                </div>
              </div>
            </div>
          ))}
          <div className="knowledge-editor-actions">
            <button disabled={busy} onClick={() => void library.refreshSavedComparison()}>
              Refresh saved comparison
            </button>
            <button
              disabled={busy || copy!.savedComparisonUnavailable}
              onClick={() => void library.resolveInitialSaveConflict(true)}
            >
              Use saved draft
            </button>
            {(copy!.initialSaveConflict.state === 'accepted' ||
              copy!.initialSaveConflict.state === 'closed') && (
              <button
                disabled={busy || copy!.savedComparisonUnavailable}
                onClick={() => void library.startNewChangeWithEdits()}
              >
                Start new change with my edits
              </button>
            )}
            <button
              disabled={
                busy ||
                copy!.savedComparisonUnavailable ||
                copy!.initialSaveConflict.state === 'accepted' ||
                copy!.initialSaveConflict.state === 'closed'
              }
              onClick={() => void library.resolveInitialSaveConflict(false)}
            >
              Keep my edits and update saved draft
            </button>
          </div>
        </section>
      )}
      {(library.error || library.comparison || copy!.forkNeedsComparison) &&
        editable &&
        !copy!.initialSaveConflict && (
          <button
            className="workspace-text-link"
            disabled={busy}
            onClick={() => void library.compare()}
          >
            Compare accepted version
          </button>
        )}
      {library.comparison && !copy!.initialSaveConflict && (
        <section className="knowledge-comparison" aria-label="Compare accepted and draft">
          <h3>Review the latest accepted knowledge</h3>
          <p>
            Your draft is preserved. Choose how to reconcile every document, then Save updates its
            review.
          </p>
          {library.comparison.documents.map((latest) => (
            <div key={latest.path}>
              <h4>{latest.path}</h4>
              <div className="knowledge-compare-panes">
                <div>
                  <h4>Accepted</h4>
                  <pre>{latest.content ?? 'No longer in accepted knowledge'}</pre>
                </div>
                <div>
                  <h4>Your draft</h4>
                  <pre>{copy!.documents.find((d) => d.path === latest.path)?.content}</pre>
                </div>
              </div>
            </div>
          ))}
          {library.comparison.documents.some((d) => d.content === null) && (
            <p>
              Documents outside accepted knowledge must be explicitly excluded. Your edits remain
              here until you choose.
            </p>
          )}
          {library.comparison.documents.every((d) => d.content === null) && (
            <p>
              Every document in this draft is outside the accepted Library. Exclude these documents
              to choose a current document; Save becomes available after you add one.
            </p>
          )}
          <div className="knowledge-editor-actions">
            {library.comparison.documents.some((d) => d.content === null) && (
              <button
                disabled={busy}
                onClick={() =>
                  void library.excludeRemovedDocuments().then((empty) => {
                    if (empty) {
                      setAdding(true);
                      setReading(false);
                    }
                  })
                }
              >
                {library.comparison.documents.every((d) => d.content === null)
                  ? 'Exclude removed documents and choose a document'
                  : 'Exclude removed documents and save'}
              </button>
            )}
            <button
              disabled={busy || library.comparison.documents.some((d) => d.content === null)}
              onClick={() =>
                void library.save(
                  library.comparison!.revision,
                  copy!.documents,
                  library.comparison!.newChange,
                )
              }
            >
              {library.comparison.newChange
                ? 'Keep my edits in a new change'
                : 'Keep my draft and save'}
            </button>
            <button
              disabled={busy || library.comparison.documents.some((d) => d.content === null)}
              onClick={() =>
                void library.save(
                  library.comparison!.revision,
                  copy!.documents.map((d) => ({
                    ...d,
                    content:
                      library.comparison!.documents.find((latest) => latest.path === d.path)
                        ?.content ?? d.content,
                  })),
                  library.comparison!.newChange,
                )
              }
            >
              Use accepted versions and save
            </button>
          </div>
        </section>
      )}
    </>
  ) : null;
  const fullscreenStatus = (
    <>
      <div className="document-editor-status" role="status">
        {busy ? 'Saving…' : dirty ? 'Unsaved changes' : library.notice || 'Accepted version'}
      </div>
      {library.error && (
        <div className="knowledge-alert" role="alert">
          {library.error}
        </div>
      )}
      {library.storageError && (
        <div className="knowledge-alert" role="alert">
          {library.storageError}
        </div>
      )}
      {editorComparisons}
    </>
  );

  return (
    <main
      className={`workspace-page knowledge-library${showEditor ? ' knowledge-library--editing' : ''}`}
    >
      <WorkspacePageHeading title="Knowledge" description="Shared context, carefully kept." />
      {library.error && (
        <div className="knowledge-alert" role="alert">
          {library.error}
        </div>
      )}
      {library.storageError && (
        <div className="knowledge-alert" role="alert">
          {library.storageError}
        </div>
      )}
      {readerFailure && (
        <div className="knowledge-alert" role="alert">
          <p>
            Couldn't open {readerFailure.document.title}. {readerFailure.message}
          </p>
          <button onClick={() => void openReader(readerFailure.document)}>
            Retry opening document
          </button>
        </div>
      )}
      {!catalog && <p className="workspace-muted">Loading your library…</p>}
      {reader ? (
        <KnowledgeReader
          document={reader.document}
          documents={catalog?.documents}
          onOpen={(document) => void openReader(document)}
          content={reader.content}
          workingCopy={copy?.documents.some((document) => document.path === reader.document.path)}
          busy={busy}
          onBack={() => {
            ++readRequest.current;
            setReader(undefined);
            setReaderFailure(undefined);
          }}
          onEdit={() => {
            const request = ++readRequest.current;
            void library.openDocument(reader.document).then((opened) => {
              if (opened && request === readRequest.current) {
                showWorkingCopy();
              }
            });
          }}
        />
      ) : showEditor ? (
        <>
          <div className="knowledge-editor-heading">
            <div>
              <button
                className="workspace-text-link"
                disabled={busy}
                onClick={() => {
                  setReading(false);
                  setAdding(false);
                }}
              >
                ← Library
              </button>
              <h2>{copy!.title}</h2>
              <p className="workspace-muted">{selected?.path || 'Folder changes'}</p>
            </div>
            <div className="knowledge-editor-actions">
              <span role="status">
                {dirty ? 'Unsaved changes' : library.notice || 'Accepted version'}
              </span>
              <button disabled={busy} onClick={() => setDetails(!details)} aria-expanded={details}>
                Review details
              </button>
              {editable && (
                <button
                  className="btn-primary"
                  disabled={busy || !library.canSave}
                  onClick={() => void library.save()}
                >
                  {busy ? 'Saving…' : 'Save'}
                </button>
              )}
            </div>
          </div>
          <div className="knowledge-document-tabs" aria-label="Documents in this draft">
            {copy!.documents.map((d) => (
              <button
                key={d.path}
                disabled={busy}
                aria-pressed={d.path === selected?.path}
                onClick={() => library.select(d.path)}
              >
                {catalog?.documents.find((item) => item.path === d.path)?.title ||
                  d.path.split('/').pop()}
              </button>
            ))}
            {editable && (
              <button
                disabled={busy}
                onClick={() => {
                  setAdding(true);
                  setReading(false);
                }}
              >
                + Add document
              </button>
            )}
          </div>
          <div
            className={`knowledge-edit-layout${details ? ' knowledge-edit-layout--details' : ''}`}
          >
            <div className="knowledge-editor-body">
              {selected && (
                <DocumentEditor
                  key={selected.path}
                  fullscreenStatus={fullscreenStatus}
                  historyResetKey={library.historyResetKey}
                  content={selected.content}
                  ext={selected.path.match(/\.[^.]+$/)?.[0] || '.md'}
                  onChange={library.change}
                  saving={busy || !editable}
                  onSave={() => {
                    if (editable) void library.save();
                  }}
                  undo={library.undo}
                  redo={library.redo}
                  canUndo={library.canUndo}
                  canRedo={library.canRedo}
                />
              )}
              {structureChanged && (
                <section className="knowledge-pending" aria-label="Pending organization changes">
                  <h3>Organization changes</h3>
                  {copy!.directories?.map((path) => (
                    <div className="knowledge-pending-folder" key={path}>
                      <p>New folder: {path}</p>
                      {editable && (
                        <button
                          disabled={busy}
                          aria-label={`Remove new folder ${path}`}
                          onClick={() => void library.removeDirectory(path)}
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  ))}
                  {copy!.documents
                    .filter((document) => document.sourcePath)
                    .map((document) => (
                      <p key={document.path}>
                        Moved: {document.sourcePath} → {document.path}
                      </p>
                    ))}
                </section>
              )}
              {editorComparisons}
            </div>
            {details && (
              <aside className="knowledge-review" aria-label="Review details">
                <h3>Your changes</h3>
                <p>Save keeps a durable draft and opens or updates its review.</p>
                {draft ? (
                  <>
                    <p>
                      {draft.state === 'accepted'
                        ? 'Accepted · Waiting for publication'
                        : draft.state === 'closed'
                          ? 'Review closed'
                          : currentReview
                            ? draft.review?.ready
                              ? 'In review'
                              : 'Review draft saved'
                            : 'Draft saved'}
                    </p>
                    {draft.review && (
                      <a
                        aria-label="Open review"
                        href={draft.review.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Open review ↗
                      </a>
                    )}
                    {currentReview && editable && !draft.review?.ready && (
                      <button
                        className="btn-primary"
                        disabled={busy || dirty || !!copy!.initialSaveConflict}
                        onClick={() => void library.sendForReview()}
                      >
                        Send for review
                      </button>
                    )}
                    <button
                      disabled={busy || dirty || !!copy!.initialSaveConflict}
                      onClick={() => void library.reconcile()}
                    >
                      Check review status
                    </button>
                    <button disabled={busy} onClick={() => void library.startNewChangeWithEdits()}>
                      Start new change
                    </button>
                    {library.gate?.reason && <p role="status">{library.gate.reason}</p>}
                    {catalog?.acceptanceEnabled && currentReview && editable && (
                      <button
                        disabled={
                          busy ||
                          dirty ||
                          !!copy!.initialSaveConflict ||
                          !library.gate?.canAccept ||
                          (library.gate.currentHead !== undefined &&
                            library.gate.currentHead !== draft.review?.head)
                        }
                        onClick={() => void library.accept()}
                      >
                        Accept changes
                      </button>
                    )}
                    <p className="workspace-muted">
                      Acceptance requires current checks and reviewer approval. Publication and
                      delivery to chats happen separately.
                    </p>
                  </>
                ) : (
                  <p className="workspace-muted">
                    Your edits are backed up on this device. Save to keep a shared draft.
                  </p>
                )}
                {!catalog?.reviewEnabled && (
                  <p>Review publishing is not configured. You can still save drafts.</p>
                )}
                <button disabled={busy} className="workspace-text-link" onClick={library.discard}>
                  Discard working copy
                </button>
              </aside>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="knowledge-top">
            <div className="knowledge-switch" aria-label="Knowledge collection">
              <button
                aria-pressed={tab === 'library'}
                onClick={() => {
                  ++readRequest.current;
                  setTab('library');
                  setAdding(false);
                }}
              >
                Library
              </button>
              <button
                aria-pressed={tab === 'drafts'}
                onClick={() => {
                  ++readRequest.current;
                  setTab('drafts');
                  setAdding(false);
                }}
              >
                Drafts ({catalog?.drafts.length || 0})
              </button>
            </div>
            <button disabled={busy} onClick={() => void library.refresh()}>
              Refresh
            </button>
          </div>
          {copy && (
            <div className="knowledge-resume">
              <span>
                {closedEmpty
                  ? library.notice ||
                    'This change is closed. Clear the working copy to start a new change.'
                  : adding
                    ? 'Choose a document to add to your change set.'
                    : dirty
                      ? 'Your unsaved working copy is ready to continue.'
                      : 'Continue your working copy.'}
              </span>
              {closedEmpty ? (
                <button disabled={busy} onClick={library.discard}>
                  Discard working copy
                </button>
              ) : !copy.documents.length &&
                !copy.directories?.length &&
                !copy.initialSaveConflict &&
                editable ? (
                <button
                  disabled={busy}
                  onClick={() => {
                    ++readRequest.current;
                    setReaderFailure(undefined);
                    setReader(undefined);
                    setAdding(true);
                    setReading(false);
                  }}
                >
                  + Add document
                </button>
              ) : (
                <button
                  disabled={
                    busy ||
                    (copy.documents.length === 0 &&
                      !copy.directories?.length &&
                      !copy.initialSaveConflict)
                  }
                  onClick={() => {
                    showWorkingCopy();
                    setAdding(false);
                  }}
                >
                  {copy.documents.length ? 'Resume editing' : 'Review changes'}
                </button>
              )}
            </div>
          )}
          {structureChanged && (
            <section className="knowledge-pending" aria-label="Pending organization changes">
              <div className="knowledge-top">
                <strong>Pending changes</strong>
                <button
                  className="btn-primary"
                  disabled={busy || !library.canSave}
                  onClick={() => void library.save()}
                >
                  Save
                </button>
              </div>
              {copy!.directories?.map((path) => (
                <div className="knowledge-pending-folder" key={path}>
                  <p>New folder: {path}</p>
                  {editable && (
                    <button
                      disabled={busy}
                      aria-label={`Remove new folder ${path}`}
                      onClick={() => void library.removeDirectory(path)}
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}
              {copy!.documents
                .filter((document) => document.sourcePath)
                .map((document) => (
                  <p key={document.path}>
                    Moved: {document.sourcePath} → {document.path}
                  </p>
                ))}
              <p className="workspace-muted">
                Save keeps these changes with your draft for review.
              </p>
            </section>
          )}
          {tab === 'library' ? (
            <div className="knowledge-browser">
              <aside className="knowledge-areas" aria-label="Knowledge areas">
                <p className="knowledge-eyebrow">YOUR LIBRARY</p>
                {['All knowledge', ...areas].map((name) => (
                  <button key={name} aria-pressed={area === name} onClick={() => setArea(name)}>
                    {name}
                    <span>
                      {catalog?.documents.filter((d) => name === 'All knowledge' || d.area === name)
                        .length || 0}
                    </span>
                  </button>
                ))}
                <p className="workspace-muted">Accepted knowledge shared across your work.</p>
              </aside>
              <section className="knowledge-shelf">
                <div className="knowledge-shelf-heading">
                  <div>
                    <p className="knowledge-eyebrow">
                      {area === 'All knowledge' ? 'CURATED CONTEXT' : area.toUpperCase()}
                    </p>
                    <h2>{area}</h2>
                    <p className="workspace-muted">
                      Principles, people and processes worth remembering.
                    </p>
                  </div>
                  <input
                    type="search"
                    aria-label="Search knowledge"
                    placeholder="Find a document…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <div className="knowledge-tree-toolbar">
                  <p className="workspace-muted">
                    {parent
                      ? `Current folder: ${parent}`
                      : 'Choose a folder to organize your knowledge.'}
                  </p>
                  <button disabled={busy || !editable} onClick={() => setDialog('folder')}>
                    New folder
                  </button>
                </div>
                <KnowledgeTree
                  documents={documents}
                  directories={visibleDirectories}
                  search={search}
                  busy={busy}
                  selectedFolder={parent}
                  onFolder={setParent}
                  onOpen={(document) => void openReader(document)}
                  onMore={editable ? setMenu : undefined}
                />
                {catalog && !documents.length && (
                  <p className="workspace-muted">No documents match this view.</p>
                )}
                <p className="knowledge-sync workspace-muted">
                  {catalog?.syncedAt
                    ? `Last refreshed ${new Date(catalog.syncedAt).toLocaleString()}`
                    : 'Accepted knowledge'}{' '}
                  · {documents.length} documents
                </p>
              </section>
            </div>
          ) : (
            <section className="knowledge-drafts">
              <h2>Your drafts</h2>
              <p className="workspace-muted">
                Changes stay here across chats and devices after saving.
              </p>
              {catalog?.drafts.map((item) => (
                <button
                  className="knowledge-card"
                  key={item.id}
                  disabled={busy}
                  onClick={() => {
                    ++readRequest.current;
                    setReaderFailure(undefined);
                    library.openDraft(item);
                    setReading(true);
                  }}
                >
                  <span className="knowledge-card-content">
                    <strong>{item.title}</strong>
                    <span className="workspace-muted">
                      {item.documents.length} documents ·{' '}
                      {item.state === 'accepted'
                        ? 'Accepted · Waiting for publication'
                        : item.review?.version === item.version
                          ? item.review.ready
                            ? 'In review'
                            : 'Review draft saved'
                          : item.state === 'closed'
                            ? 'Closed'
                            : 'Draft'}{' '}
                      · {new Date(item.updatedAt).toLocaleDateString()}
                    </span>
                  </span>
                  <span aria-hidden="true">↗</span>
                </button>
              ))}
              {catalog?.drafts.length === 0 && (
                <p className="workspace-muted">
                  Open a document from the Library to start a draft.
                </p>
              )}
            </section>
          )}
        </>
      )}
      {menu && !dialog && (
        <div className="knowledge-file-menu" role="dialog" aria-label="Document options">
          <p className="workspace-muted">{menu.path}</p>
          <button
            disabled={
              busy ||
              !library.directories.some((directory) =>
                library.canMoveDocument(menu.path, `${directory}/${menu.path.split('/').pop()}`),
              )
            }
            onClick={() => {
              ++readRequest.current;
              setReaderFailure(undefined);
              setReader(undefined);
              setReading(false);
              setDialog('move');
            }}
          >
            Move document
          </button>
          <button onClick={() => setMenu(undefined)}>Close</button>
        </div>
      )}
      {dialog && (
        <KnowledgeOrganizationDialog
          mode={dialog}
          directories={dialog === 'folder' ? folderParents : library.directories}
          initialParent={
            dialog === 'folder' ? parent : menu?.path.split('/').slice(0, -1).join('/') || ''
          }
          source={dialog === 'move' ? menu?.path : undefined}
          busy={busy}
          error={library.error}
          canChooseParent={library.canCreateInDirectory}
          canChoose={(path) =>
            dialog === 'folder'
              ? library.canCreateDirectory(path)
              : library.canMoveDocument(menu!.path, path)
          }
          onSubmit={async (path) => {
            const applied =
              dialog === 'folder'
                ? library.createDirectory(path)
                : await library.moveAcceptedDocument(menu!, path);
            if (applied) {
              setAdding(false);
              ++readRequest.current;
              setReaderFailure(undefined);
              setReader(undefined);
              setParent(path.split('/').slice(0, -1).join('/'));
              setReading(false);
            }
            return applied;
          }}
          onClose={() => {
            setDialog(undefined);
            setMenu(undefined);
          }}
        />
      )}
    </main>
  );
}
