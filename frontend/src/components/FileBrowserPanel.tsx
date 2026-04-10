import { useState, useEffect, useCallback } from 'react';

interface DirEntry {
  name: string;
  isDir: boolean;
}

export interface FileRoot {
  label: string;
  path: string;
}

export interface FileBrowserPanelProps {
  roots?: FileRoot[];
  loaded?: boolean;
}

export function FileBrowserPanel({
  roots: externalRoots,
  loaded: externalLoaded,
}: FileBrowserPanelProps) {
  const [selfRoots, setSelfRoots] = useState<FileRoot[]>([]);
  const [selfLoaded, setSelfLoaded] = useState(false);

  // Self-fetch config only when not provided via props (standalone usage)
  useEffect(() => {
    if (externalRoots !== undefined) return;
    fetch('/api/config', { credentials: 'include' })
      .then((r) => r.json())
      .then((data: { fileViewerRoots?: FileRoot[] }) => {
        setSelfRoots(data.fileViewerRoots ?? []);
        setSelfLoaded(true);
      })
      .catch(() => setSelfLoaded(true));
  }, [externalRoots]);

  const roots = externalRoots ?? selfRoots;
  const loaded = externalLoaded ?? selfLoaded;

  const [activeRoot, setActiveRoot] = useState('');
  const [currentDir, setCurrentDir] = useState('');
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [preview, setPreview] = useState<{ name: string; content: string } | null>(null);

  // Set initial root when roots become available
  useEffect(() => {
    if (roots.length > 0 && !activeRoot) {
      setActiveRoot(roots[0].path);
      setCurrentDir(roots[0].path);
    }
  }, [roots, activeRoot]);

  // Fetch directory listing when root changes or navigating
  const [fetchDir, setFetchDir] = useState('');

  useEffect(() => {
    if (!activeRoot) return;
    const dir = fetchDir || activeRoot;
    const params = new URLSearchParams({ dir });
    fetch(`/api/files/list?${params}`, { credentials: 'include' })
      .then((r) => r.json())
      .then((data: { entries: DirEntry[]; currentDir: string }) => {
        setEntries(data.entries ?? []);
        // Don't feed server response back into dependencies — trust client state
        setCurrentDir(data.currentDir);
      })
      .catch(() => setEntries([]));
  }, [activeRoot, fetchDir]);

  const navigateToDir = useCallback(
    (dirName: string) => {
      setPreview(null);
      let target: string;
      if (dirName === '..') {
        const parent = currentDir.split('/').slice(0, -1).join('/');
        target = parent || activeRoot;
      } else {
        target = `${currentDir}/${dirName}`;
      }
      setCurrentDir(target);
      setFetchDir(target);
    },
    [currentDir, activeRoot],
  );

  const openFile = useCallback(
    (fileName: string) => {
      const filePath = `${currentDir}/${fileName}`;
      fetch(`/api/files/read?path=${encodeURIComponent(filePath)}`, { credentials: 'include' })
        .then((r) => r.json())
        .then((data: { content: string }) => {
          setPreview({ name: fileName, content: data.content });
        })
        .catch(() => {});
    },
    [currentDir],
  );

  const handleRootChange = useCallback((rootPath: string) => {
    setActiveRoot(rootPath);
    setCurrentDir(rootPath);
    setFetchDir(rootPath);
    setPreview(null);
  }, []);

  // Normalize trailing slashes for comparison to avoid false isSubdir
  const normDir = currentDir.replace(/\/+$/, '');
  const normRoot = activeRoot.replace(/\/+$/, '');
  const isSubdir = normDir !== normRoot && normDir !== '';

  if (!loaded) return null;

  return (
    <div className="file-browser-panel">
      <div className="file-browser-header">Files</div>

      {roots.length > 1 && (
        <div className="file-browser-roots">
          {roots.map((r) => (
            <button
              key={r.path}
              className={`file-browser-root${r.path === activeRoot ? ' file-browser-root--active' : ''}`}
              onClick={() => handleRootChange(r.path)}
            >
              {r.label}
            </button>
          ))}
        </div>
      )}

      {preview ? (
        <div className="file-browser-preview">
          <button className="file-browser-back" onClick={() => setPreview(null)}>
            &larr; {preview.name}
          </button>
          <pre className="file-browser-preview-content">{preview.content}</pre>
        </div>
      ) : (
        <div className="file-browser-listing">
          {isSubdir && (
            <button
              className="file-browser-entry file-browser-entry--dir"
              onClick={() => navigateToDir('..')}
            >
              ..
            </button>
          )}
          {entries.length === 0 && !isSubdir && (
            <p className="file-browser-empty">Empty directory</p>
          )}
          {entries.map((entry) => (
            <button
              key={entry.name}
              className={`file-browser-entry${entry.isDir ? ' file-browser-entry--dir' : ''}`}
              onClick={() => (entry.isDir ? navigateToDir(entry.name) : openFile(entry.name))}
            >
              {entry.isDir ? `${entry.name}/` : entry.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
