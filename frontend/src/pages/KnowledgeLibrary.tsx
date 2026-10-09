import { useState } from 'react';
import { DocumentEditor } from '../components/DocumentEditor';
import { WorkspacePageHeading } from '../components/WorkspacePageHeading';
import { useKnowledgeLibrary } from '../hooks/useKnowledgeLibrary';
export function KnowledgeLibrary() {
  const library = useKnowledgeLibrary();
  const { catalog, copy, selected, dirty, busy } = library;
  const [tab, setTab] = useState<'library' | 'drafts'>('library');
  const [search, setSearch] = useState('');
  const [area, setArea] = useState('All knowledge');
  const [reading, setReading] = useState(true);
  const [details, setDetails] = useState(false);
  const [adding, setAdding] = useState(false);
  const areas = [...new Set(catalog?.documents.map((d) => d.area) || [])];
  const documents =
    catalog?.documents.filter(
      (d) =>
        (area === 'All knowledge' || d.area === area) &&
        `${d.title} ${d.path}`.toLowerCase().includes(search.toLowerCase()),
    ) || [];
  const draft = copy?.draft;
  const editable = !draft || draft.state === 'draft' || draft.state === 'in-review';
  const currentReview = !!draft?.review && draft.review.version === draft.version;
  const showEditor = !!selected && reading;
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
      {!catalog && <p className="workspace-muted">Loading your library…</p>}
      {showEditor ? (
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
              <p className="workspace-muted">{selected.path}</p>
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
                aria-pressed={d.path === selected.path}
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
              <DocumentEditor
                key={selected.path}
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
              {copy!.initialSaveConflict && (
                <section
                  className="knowledge-comparison"
                  aria-label="Compare saved draft and working copy"
                >
                  <h3>This saved draft changed on another device</h3>
                  <p>
                    Your working copy is preserved. Compare every document before choosing which
                    version to keep. Updating the saved draft replaces its contents with your
                    working copy.
                  </p>
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
                            {copy!.initialSaveConflict!.documents.find((d) => d.path === path)
                              ?.content ?? 'Not in the saved draft.'}
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
                      disabled={busy}
                      onClick={() => void library.resolveInitialSaveConflict(true)}
                    >
                      Use saved draft
                    </button>
                    <button
                      disabled={
                        busy ||
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
              {(library.error || library.comparison) && editable && !copy!.initialSaveConflict && (
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
                    Your draft is preserved. Choose how to reconcile every document, then Save
                    updates its review.
                  </p>
                  {library.comparison.documents.map((latest) => (
                    <div key={latest.path}>
                      <h4>{latest.path}</h4>
                      <div className="knowledge-compare-panes">
                        <div>
                          <h4>Accepted</h4>
                          <pre>{latest.content}</pre>
                        </div>
                        <div>
                          <h4>Your draft</h4>
                          <pre>{copy!.documents.find((d) => d.path === latest.path)?.content}</pre>
                        </div>
                      </div>
                    </div>
                  ))}
                  <div className="knowledge-editor-actions">
                    <button
                      disabled={busy}
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
                      disabled={busy}
                      onClick={() =>
                        void library.save(
                          library.comparison!.revision,
                          copy!.documents.map((d) => ({
                            ...d,
                            content: library.comparison!.documents.find(
                              (latest) => latest.path === d.path,
                            )!.content,
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
                        disabled={busy || dirty}
                        onClick={() => void library.sendForReview()}
                      >
                        Send for review
                      </button>
                    )}
                    <button disabled={busy || dirty} onClick={() => void library.reconcile()}>
                      Check review status
                    </button>
                    <button disabled={busy} onClick={() => void library.compare(true)}>
                      Start new change
                    </button>
                    {library.gate?.reason && <p role="status">{library.gate.reason}</p>}
                    {catalog?.acceptanceEnabled && currentReview && editable && (
                      <button
                        disabled={
                          busy ||
                          dirty ||
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
              <button aria-pressed={tab === 'library'} onClick={() => setTab('library')}>
                Library
              </button>
              <button
                aria-pressed={tab === 'drafts'}
                onClick={() => {
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
                {adding
                  ? 'Choose a document to add to your change set.'
                  : dirty
                    ? 'Your unsaved working copy is ready to continue.'
                    : 'Continue your working copy.'}
              </span>
              <button
                disabled={busy}
                onClick={() => {
                  setReading(true);
                  setAdding(false);
                }}
              >
                Resume editing
              </button>
            </div>
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
                <div className="knowledge-cards">
                  {documents.map((doc) => (
                    <button
                      disabled={
                        busy || (adding && copy?.documents.some((d) => d.path === doc.path))
                      }
                      className="knowledge-card"
                      key={doc.path}
                      onClick={() =>
                        void library.openDocument(doc, adding).then(() => {
                          if (library.copy || !busy) {
                            setReading(true);
                            setAdding(false);
                          }
                        })
                      }
                    >
                      <span className="knowledge-card-icon" aria-hidden="true">
                        ▤
                      </span>
                      <span className="knowledge-card-content">
                        <span className="knowledge-eyebrow">{doc.area}</span>
                        <strong>{doc.title}</strong>
                        <span className="workspace-muted">{doc.path}</span>
                      </span>
                      <span aria-hidden="true">↗</span>
                    </button>
                  ))}
                </div>
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
    </main>
  );
}
