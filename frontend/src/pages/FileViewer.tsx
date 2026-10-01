import { useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import {
  remarkPlugins,
  rehypePlugins,
  artifactMarkdownComponents,
  artifactUrlTransform,
} from '../lib/markdown-config';
import { ShareButton } from '../components/ShareButton';
import { MitzoLogo } from '../components/MitzoLogo';
import { useFileNavigation } from '../hooks/useFileNavigation';
import { useEditorViewport } from '../hooks/useEditorViewport';
import { useFileEditor } from '../hooks/useFileEditor';
import { useDocumentReader } from '../hooks/useDocumentReader';
import { DocumentEditor } from '../components/DocumentEditor';
import { HtmlPreview } from '../components/HtmlPreview';
import { findArtifactCapabilityByExtension } from '@mitzo/protocol';

export function FileViewer() {
  const [params] = useSearchParams();
  return <FileViewerDocument key={JSON.stringify([params.get('sessionId'), params.get('path')])} />;
}

function FileViewerDocument() {
  const viewportRef = useEditorViewport();
  const [searchParams, setSearchParams] = useSearchParams();
  const routerNavigate = useNavigate();
  const location = useLocation();
  const nav = useFileNavigation(searchParams, setSearchParams);
  const { state } = nav;
  const rawFrom = searchParams.get('from');
  // Validate fromRoute: must be a relative path, no protocol-relative URLs
  const fromRoute =
    rawFrom && rawFrom.startsWith('/') && !rawFrom.startsWith('//') ? rawFrom : null;

  const editor = useFileEditor(
    state.content,
    state.filePath,
    nav.setError,
    state.sessionId || undefined,
  );
  const reader = useDocumentReader();

  const isMarkdown = ['.md', '.mdx'].includes(state.ext);
  const artifactCapability = findArtifactCapabilityByExtension(state.ext);
  const isHtml = artifactCapability?.artifact?.renderer === 'html';
  const isEditable = isMarkdown || artifactCapability?.artifact?.editable === true;
  const fileName = state.filePath.split('/').pop() || '';
  const dirName = state.currentDir.split('/').pop() || 'Files';
  const displayBranch =
    state.gitInfo?.worktrees.find((w) => w.path === state.activeRoot)?.branch ||
    state.gitInfo?.branch ||
    '';

  return (
    <div className="viewer-page" ref={viewportRef}>
      <header className="viewer-header">
        <MitzoLogo />
        {(state.isViewing || state.canGoUp || fromRoute) && (
          <button
            className="viewer-header-back"
            onClick={() => {
              if (editor.saving) return;
              if (editor.dirty && !confirm('Discard unsaved changes?')) return;
              editor.resetEditor();
              if (fromRoute) {
                routerNavigate(fromRoute);
              } else {
                nav.handleBack(false); // dirty already checked above
              }
            }}
          >
            &larr;
          </button>
        )}
        <span className="viewer-header-title">{state.isViewing ? fileName : dirName}</span>

        {displayBranch && <span className="viewer-header-branch">{displayBranch}</span>}

        {state.isViewing && !editor.editing && (
          <ShareButton
            filePath={state.filePath}
            sessionId={state.sessionId || undefined}
            className="share-btn--visible viewer-header-share"
          />
        )}
        {state.isViewing && isMarkdown && !editor.editing && reader.available && (
          <button
            className={`viewer-header-action${reader.state !== 'idle' ? ' viewer-header-action--active' : ''}`}
            onClick={() => {
              if (reader.state !== 'idle') {
                reader.stop();
              } else {
                reader.read(state.content);
              }
            }}
            disabled={reader.state === 'loading'}
          >
            {reader.state === 'loading'
              ? 'Loading...'
              : reader.state === 'playing'
                ? 'Stop'
                : 'Read'}
          </button>
        )}
        {state.isViewing && isEditable && !editor.editing && (
          <button
            className="viewer-header-action"
            onClick={editor.startEditing}
            disabled={state.loading || !!state.error}
          >
            Edit
          </button>
        )}
        {editor.editing && (
          <>
            <button
              className="viewer-header-action viewer-header-action--save"
              onClick={() => editor.saveFile(nav.setContent)}
              disabled={editor.saving || !editor.dirty}
            >
              {editor.saving ? 'Saving...' : 'Save'}
            </button>
            <button
              className="viewer-header-action viewer-header-action--cancel"
              onClick={editor.cancelEditing}
              disabled={editor.saving}
            >
              {editor.dirty ? 'Discard' : 'Done'}
            </button>
          </>
        )}
      </header>

      {!state.isViewing &&
        (state.roots.length > 0 || (state.gitInfo && state.gitInfo.worktrees.length > 0)) && (
          <div className="viewer-root-bar">
            {state.roots.length > 0 ? (
              state.roots.map((root) => (
                <button
                  key={root.path}
                  className={`viewer-root-btn${state.activeRoot === root.path ? ' viewer-root-btn--active' : ''}`}
                  onClick={() => {
                    editor.resetEditor();
                    nav.handleRootChange(root.path, editor.dirty);
                  }}
                >
                  {root.label}
                </button>
              ))
            ) : state.gitInfo ? (
              <button
                className={`viewer-root-btn${state.activeRoot === state.gitInfo.repoPath ? ' viewer-root-btn--active' : ''}`}
                onClick={() => {
                  editor.resetEditor();
                  nav.handleRootChange(state.gitInfo!.repoPath, editor.dirty);
                }}
              >
                main
              </button>
            ) : null}
            {state.gitInfo?.worktrees.map((wt) => (
              <button
                key={wt.path}
                className={`viewer-root-btn${state.activeRoot === wt.path ? ' viewer-root-btn--active' : ''}`}
                onClick={() => {
                  editor.resetEditor();
                  nav.handleRootChange(wt.path, editor.dirty);
                }}
                title={`${wt.branch} (${wt.age})`}
              >
                {wt.branch || wt.name}
              </button>
            ))}
          </div>
        )}

      {editor.editing && (
        <div className="document-editor-status" role="status">
          {editor.error ||
            (editor.saving
              ? 'Saving…'
              : editor.dirty
                ? 'Unsaved changes · draft kept on this device'
                : 'All changes saved')}
          {editor.error && (
            <button
              type="button"
              onClick={editor.reviewLatest}
              disabled={editor.saving || editor.reviewing}
            >
              {editor.reviewing ? 'Loading…' : 'Review latest version'}
            </button>
          )}
        </div>
      )}
      {editor.editing && editor.latestContent !== null && editor.latestContent !== undefined && (
        <section className="document-conflict" aria-label="Latest saved version">
          <strong>Latest saved version</strong>
          <pre>{editor.latestContent}</pre>
          <button type="button" onClick={() => editor.resolveConflict(true, nav.setContent)}>
            Use latest version
          </button>
          <button type="button" onClick={() => editor.resolveConflict(false, nav.setContent)}>
            Keep my draft for next save
          </button>
        </section>
      )}
      <div className={`viewer-content${editor.editing ? ' viewer-content--editing' : ''}`}>
        {state.loading && <p className="viewer-status">Loading...</p>}
        {state.error && <p className="viewer-status viewer-status--error">{state.error}</p>}

        {!state.loading && !state.error && state.isViewing && editor.editing && (
          <DocumentEditor
            content={editor.editContent}
            ext={state.ext}
            onChange={editor.handleEditChange}
            saving={editor.saving}
            onSave={() => editor.saveFile(nav.setContent)}
            undo={editor.undo}
            redo={editor.redo}
            canUndo={editor.canUndo}
            canRedo={editor.canRedo}
          />
        )}

        {!state.loading && !state.error && state.isViewing && !editor.editing && isMarkdown && (
          <div className="viewer-markdown">
            <ReactMarkdown
              remarkPlugins={remarkPlugins}
              rehypePlugins={rehypePlugins}
              urlTransform={artifactUrlTransform}
              components={artifactMarkdownComponents(
                state.filePath,
                state.sessionId || undefined,
                location.pathname + location.search,
                routerNavigate,
              )}
            >
              {state.content}
            </ReactMarkdown>
          </div>
        )}

        {!state.loading && !state.error && state.isViewing && !editor.editing && isHtml && (
          <HtmlPreview
            html={state.content}
            title={`${fileName} preview`}
            className="viewer-html-preview"
          />
        )}

        {!state.loading &&
          !state.error &&
          state.isViewing &&
          !editor.editing &&
          !isMarkdown &&
          !isHtml && <pre className="viewer-code">{state.content}</pre>}

        {!state.loading && !state.error && !state.isViewing && (
          <div className="viewer-dir">
            {state.canGoUp && (
              <button
                className="viewer-entry viewer-entry--up"
                onClick={() => nav.goUp(editor.dirty)}
              >
                <span className="viewer-entry-icon">..</span>
                <span className="viewer-entry-name">Parent directory</span>
              </button>
            )}
            {state.entries.map((entry) => (
              <button
                key={entry.name}
                className={`viewer-entry ${entry.isDir ? 'viewer-entry--dir' : ''}`}
                onClick={() => nav.openEntry(entry, editor.dirty)}
              >
                <span className="viewer-entry-icon">{entry.isDir ? '/' : ''}</span>
                <span className="viewer-entry-name">{entry.name}</span>
              </button>
            ))}
            {state.entries.length === 0 && <p className="viewer-status">Empty directory</p>}
          </div>
        )}
      </div>
    </div>
  );
}
