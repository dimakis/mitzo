import { useState, useEffect, useCallback } from 'react';

interface DirEntry {
  name: string;
  isDir: boolean;
}

interface FileRoot {
  label: string;
  path: string;
}

export function FileBrowserPanel() {
  const [roots, setRoots] = useState<FileRoot[]>([]);
  const [activeRoot, setActiveRoot] = useState('');
  const [currentDir, setCurrentDir] = useState('');
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [preview, setPreview] = useState<{ name: string; content: string } | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Fetch roots from config
  useEffect(() => {
    fetch('/api/config', { credentials: 'include' })
      .then((r) => r.json())
      .then((data: { fileViewerRoots?: FileRoot[] }) => {
        const r = data.fileViewerRoots ?? [];
        setRoots(r);
        if (r.length > 0) {
          setActiveRoot(r[0].path);
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  // Fetch directory listing when root or dir changes
  useEffect(() => {
    if (!activeRoot) return;
    const params = new URLSearchParams();
    if (currentDir) params.set('dir', currentDir);
    else params.set('dir', activeRoot);

    fetch(`/api/files/list?${params}`, { credentials: 'include' })
      .then((r) => r.json())
      .then((data: { entries: DirEntry[]; currentDir: string }) => {
        setEntries(data.entries ?? []);
        setCurrentDir(data.currentDir);
      })
      .catch(() => setEntries([]));
  }, [activeRoot, currentDir]);

  const navigateToDir = useCallback(
    (dirName: string) => {
      setPreview(null);
      if (dirName === '..') {
        const parent = currentDir.split('/').slice(0, -1).join('/');
        setCurrentDir(parent || activeRoot);
      } else {
        setCurrentDir(`${currentDir}/${dirName}`);
      }
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
    setPreview(null);
  }, []);

  const isSubdir = currentDir !== activeRoot && currentDir !== '';

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
