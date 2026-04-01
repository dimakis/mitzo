import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface DirEntry {
  name: string;
  isDir: boolean;
}

export function FileViewer() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const filePath = searchParams.get('path') || '';
  const dirPath = searchParams.get('dir') || '';
  const isViewing = !!filePath;

  const [content, setContent] = useState('');
  const [ext, setExt] = useState('');
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [currentDir, setCurrentDir] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    setError('');

    if (isViewing) {
      fetch(`/api/files/read?path=${encodeURIComponent(filePath)}`)
        .then((r) => {
          if (!r.ok) throw new Error('Failed to load file');
          return r.json();
        })
        .then((data) => {
          setContent(data.content);
          setExt(data.ext);
        })
        .catch((err) => setError(err.message))
        .finally(() => setLoading(false));
    } else {
      fetch(`/api/files?dir=${encodeURIComponent(dirPath)}`)
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
  }, [filePath, dirPath, isViewing]);

  function openEntry(entry: DirEntry) {
    const full = currentDir ? `${currentDir}/${entry.name}` : entry.name;
    if (entry.isDir) {
      setSearchParams({ dir: full });
    } else {
      setSearchParams({ path: full });
    }
  }

  function goUp() {
    if (!currentDir) return;
    const parent = currentDir.replace(/\/[^/]+$/, '');
    if (parent === currentDir) {
      setSearchParams({});
    } else {
      setSearchParams({ dir: parent });
    }
  }

  function handleBack() {
    if (isViewing) {
      const parentDir = filePath.replace(/\/[^/]+$/, '');
      setSearchParams(parentDir ? { dir: parentDir } : {});
      setContent('');
      setExt('');
    } else if (currentDir) {
      goUp();
    } else {
      navigate('/');
    }
  }

  const isMarkdown = ['.md', '.mdx'].includes(ext);
  const fileName = filePath.split('/').pop() || '';
  const dirName = currentDir.split('/').pop() || 'Files';

  return (
    <div className="viewer-page">
      <header className="viewer-header">
        <button className="viewer-header-back" onClick={handleBack}>
          &larr;
        </button>
        <span className="viewer-header-title">{isViewing ? fileName : dirName}</span>
      </header>

      <div className="viewer-content">
        {loading && <p className="viewer-status">Loading...</p>}
        {error && <p className="viewer-status viewer-status--error">{error}</p>}

        {!loading && !error && isViewing && isMarkdown && (
          <div className="viewer-markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </div>
        )}

        {!loading && !error && isViewing && !isMarkdown && (
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
