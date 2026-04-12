import { useSearchParams, useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MitzoLogo } from '../components/MitzoLogo';
import { useFileNavigation } from '../hooks/useFileNavigation';
import { useFileEditor } from '../hooks/useFileEditor';
import { useDocumentReader } from '../hooks/useDocumentReader';

export function FileViewer() {
  const [searchParams, setSearchParams] = useSearchParams();
  const routerNavigate = useNavigate();
  const nav = useFileNavigation(searchParams, setSearchParams);
  const { state } = nav;
  const fromRoute = searchParams.get('from');

  const editor = useFileEditor(state.content, state.filePath, nav.setError);
  const reader = useDocumentReader();

  const isMarkdown = ['.md', '.mdx'].includes(state.ext);
  const fileName = state.filePath.split('/').pop() || '';
  const dirName = state.currentDir.split('/').pop() || 'Files';
  const displayBranch =
    state.gitInfo?.worktrees.find((w) => w.path === state.activeRoot)?.branch ||
    state.gitInfo?.branch ||
    '';

  return (
    <div className="viewer-page">
      <header className="viewer-header">
        <MitzoLogo />
        {(state.isViewing || state.currentDir || fromRoute) && (
          <button
            className="viewer-header-back"
            onClick={() => {
              editor.resetEditor();
              if (fromRoute) {
                routerNavigate(fromRoute);
              } else {
                nav.handleBack(editor.dirty);
              }
            }}
          >
            &larr;
          </button>
        )}
        <span className="viewer-header-title">{state.isViewing ? fileName : dirName}</span>

        {displayBranch && <span className="viewer-header-branch">{displayBranch}</span>}

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
        {state.isViewing && isMarkdown && !editor.editing && (
          <button className="viewer-header-action" onClick={editor.startEditing}>
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
            >
              Cancel
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

      <div className="viewer-content">
        {state.loading && <p className="viewer-status">Loading...</p>}
        {state.error && <p className="viewer-status viewer-status--error">{state.error}</p>}

        {!state.loading && !state.error && state.isViewing && editor.editing && (
          <textarea
            ref={editor.editorRef}
            className="viewer-editor"
            value={editor.editContent}
            onChange={(e) => editor.handleEditChange(e.target.value)}
            spellCheck={false}
          />
        )}

        {!state.loading && !state.error && state.isViewing && !editor.editing && isMarkdown && (
          <div className="viewer-markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{state.content}</ReactMarkdown>
          </div>
        )}

        {!state.loading && !state.error && state.isViewing && !editor.editing && !isMarkdown && (
          <pre className="viewer-code">{state.content}</pre>
        )}

        {!state.loading && !state.error && !state.isViewing && (
          <div className="viewer-dir">
            {state.currentDir && (
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
