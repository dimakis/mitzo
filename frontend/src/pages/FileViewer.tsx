import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MitzoLogo } from '../components/MitzoLogo';

interface DirEntry {
  name: string;
  isDir: boolean;
}

interface WorktreeInfo {
  name: string;
  path: string;
  branch: string;
  age: string;
}

interface GitInfo {
  branch: string;
  repoPath: string;
  worktrees: WorktreeInfo[];
}

export function FileViewer() {
  const [searchParams, setSearchParams] = useSearchParams();

  const filePath = searchParams.get('path') || '';
  const dirPath = searchParams.get('dir') || '';
  const rootParam = searchParams.get('root') || '';
  const isViewing = !!filePath;

  const [content, setContent] = useState('');
  const [ext, setExt] = useState('');
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [currentDir, setCurrentDir] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);
  const [activeRoot, setActiveRoot] = useState(rootParam);

  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fetch('/api/git/info')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: GitInfo | null) => {
        if (data) {
          setGitInfo(data);
          if (!activeRoot) setActiveRoot(data.repoPath);
        }
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setLoading(true);
    setError('');

    const rootQ = activeRoot ? `&root=${encodeURIComponent(activeRoot)}` : '';

    if (isViewing) {
      fetch(`/api/files/read?path=${encodeURIComponent(filePath)}`)
        .then((r) => {
          if (!r.ok) throw new Error('Failed to load file');
          return r.json();
        })
        .then((data) => {
          setContent(data.content);
          setExt(data.ext);
          setEditing(false);
          setDirty(false);
        })
        .catch((err) => setError(err.message))
        .finally(() => setLoading(false));
    } else {
      fetch(`/api/files?dir=${encodeURIComponent(dirPath)}${rootQ}`)
        .then((r) => {
          if (!r.ok) throw new Error('Failed to load directory');
          return r.json();
        })
        .then((data) => {
          setEntries(data.entries);
          setCurrentDir(data.dir);
        })
        .catch((err) => setError(err.message))
        .finally(() => setLoading(false));
    }
  }, [filePath, dirPath, isViewing, activeRoot]);

  function openEntry(entry: DirEntry) {
    if (dirty && !confirm('Discard unsaved changes?')) return;
    const full = currentDir ? `${currentDir}/${entry.name}` : entry.name;
    const params: Record<string, string> = {};
    if (activeRoot) params.root = activeRoot;
    if (entry.isDir) {
      params.dir = full;
    } else {
      params.path = full;
    }
    setSearchParams(params);
  }

  function goUp() {
    if (dirty && !confirm('Discard unsaved changes?')) return;
    if (!currentDir) return;
    const parent = currentDir.replace(/\/[^/]+$/, '');
    const params: Record<string, string> = {};
    if (activeRoot) params.root = activeRoot;
    if (parent === currentDir) {
      setSearchParams(params);
    } else {
      params.dir = parent;
      setSearchParams(params);
    }
  }

  function handleBack() {
    if (dirty && !confirm('Discard unsaved changes?')) return;
    if (isViewing) {
      const parentDir = filePath.replace(/\/[^/]+$/, '');
      const params: Record<string, string> = {};
      if (activeRoot) params.root = activeRoot;
      if (parentDir) params.dir = parentDir;
      setSearchParams(params);
      setContent('');
      setExt('');
      setEditing(false);
      setDirty(false);
    } else if (currentDir) {
      goUp();
    }
  }

  function handleRootChange(newRoot: string) {
    if (dirty && !confirm('Discard unsaved changes?')) return;
    setActiveRoot(newRoot);
    const params: Record<string, string> = {};
    if (newRoot) params.root = newRoot;
    setSearchParams(params);
    setEditing(false);
    setDirty(false);
  }

  const startEditing = useCallback(() => {
    setEditContent(content);
    setEditing(true);
    setDirty(false);
    requestAnimationFrame(() => editorRef.current?.focus());
  }, [content]);

  function handleEditChange(value: string) {
    setEditContent(value);
    setDirty(value !== content);
  }

  function cancelEditing() {
    if (dirty && !confirm('Discard unsaved changes?')) return;
    setEditing(false);
    setDirty(false);
  }

  async function saveFile() {
    setSaving(true);
    try {
      const res = await fetch('/api/files/write', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, content: editContent }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Save failed' }));
        throw new Error(data.error || 'Save failed');
      }
      setContent(editContent);
      setEditing(false);
      setDirty(false);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Save failed';
      setError(message);
    } finally {
      setSaving(false);
    }
  }

  const isMarkdown = ['.md', '.mdx'].includes(ext);
  const fileName = filePath.split('/').pop() || '';
  const dirName = currentDir.split('/').pop() || 'Files';
  const displayBranch =
    gitInfo?.worktrees.find((w) => w.path === activeRoot)?.branch || gitInfo?.branch || '';

  return (
    <div className="viewer-page">
      <header className="viewer-header">
        <MitzoLogo />
        {(isViewing || currentDir) && (
          <button className="viewer-header-back" onClick={handleBack}>
            &larr;
          </button>
        )}
        <span className="viewer-header-title">{isViewing ? fileName : dirName}</span>

        {displayBranch && <span className="viewer-header-branch">{displayBranch}</span>}

        {isViewing && isMarkdown && !editing && (
          <button className="viewer-header-action" onClick={startEditing}>
            Edit
          </button>
        )}
        {editing && (
          <>
            <button
              className="viewer-header-action viewer-header-action--save"
              onClick={saveFile}
              disabled={saving || !dirty}
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button
              className="viewer-header-action viewer-header-action--cancel"
              onClick={cancelEditing}
            >
              Cancel
            </button>
          </>
        )}
      </header>

      {gitInfo && gitInfo.worktrees.length > 0 && !isViewing && (
        <div className="viewer-root-bar">
          <button
            className={`viewer-root-btn${activeRoot === gitInfo.repoPath ? ' viewer-root-btn--active' : ''}`}
            onClick={() => handleRootChange(gitInfo.repoPath)}
          >
            main
          </button>
          {gitInfo.worktrees.map((wt) => (
            <button
              key={wt.path}
              className={`viewer-root-btn${activeRoot === wt.path ? ' viewer-root-btn--active' : ''}`}
              onClick={() => handleRootChange(wt.path)}
              title={`${wt.branch} (${wt.age})`}
            >
              {wt.branch || wt.name}
            </button>
          ))}
        </div>
      )}

      <div className="viewer-content">
        {loading && <p className="viewer-status">Loading...</p>}
        {error && <p className="viewer-status viewer-status--error">{error}</p>}

        {!loading && !error && isViewing && editing && (
          <textarea
            ref={editorRef}
            className="viewer-editor"
            value={editContent}
            onChange={(e) => handleEditChange(e.target.value)}
            spellCheck={false}
          />
        )}

        {!loading && !error && isViewing && !editing && isMarkdown && (
          <div className="viewer-markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </div>
        )}

        {!loading && !error && isViewing && !editing && !isMarkdown && (
          <pre className="viewer-code">{content}</pre>
        )}

        {!loading && !error && !isViewing && (
          <div className="viewer-dir">
            {currentDir && (
              <button className="viewer-entry viewer-entry--up" onClick={goUp}>
                <span className="viewer-entry-icon">..</span>
                <span className="viewer-entry-name">Parent directory</span>
              </button>
            )}
            {entries.map((entry) => (
              <button
                key={entry.name}
                className={`viewer-entry ${entry.isDir ? 'viewer-entry--dir' : ''}`}
                onClick={() => openEntry(entry)}
              >
                <span className="viewer-entry-icon">{entry.isDir ? '/' : ''}</span>
                <span className="viewer-entry-name">{entry.name}</span>
              </button>
            ))}
            {entries.length === 0 && <p className="viewer-status">Empty directory</p>}
          </div>
        )}
      </div>
    </div>
  );
}
