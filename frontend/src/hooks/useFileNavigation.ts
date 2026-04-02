import { useState, useEffect } from 'react';
import type { SetURLSearchParams } from 'react-router-dom';

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

export interface FileNavState {
  content: string;
  ext: string;
  entries: DirEntry[];
  currentDir: string;
  loading: boolean;
  error: string;
  gitInfo: GitInfo | null;
  activeRoot: string;
  isViewing: boolean;
  filePath: string;
  dirPath: string;
}

export function useFileNavigation(
  searchParams: URLSearchParams,
  setSearchParams: SetURLSearchParams,
) {
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

  useEffect(() => {
    fetch('/api/git/info')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: GitInfo | null) => {
        if (data) {
          setGitInfo(data);
          if (!activeRoot) setActiveRoot(data.repoPath);
        }
      })
      .catch(() => {
        // Network error loading git info — non-fatal
      });
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

  function openEntry(entry: DirEntry, dirty: boolean) {
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

  function goUp(dirty: boolean) {
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

  function handleBack(dirty: boolean) {
    if (dirty && !confirm('Discard unsaved changes?')) return;
    if (isViewing) {
      const parentDir = filePath.replace(/\/[^/]+$/, '');
      const params: Record<string, string> = {};
      if (activeRoot) params.root = activeRoot;
      if (parentDir) params.dir = parentDir;
      setSearchParams(params);
      setContent('');
      setExt('');
    } else if (currentDir) {
      goUp(false);
    }
  }

  function handleRootChange(newRoot: string, dirty: boolean) {
    if (dirty && !confirm('Discard unsaved changes?')) return;
    setActiveRoot(newRoot);
    const params: Record<string, string> = {};
    if (newRoot) params.root = newRoot;
    setSearchParams(params);
  }

  const state: FileNavState = {
    content,
    ext,
    entries,
    currentDir,
    loading,
    error,
    gitInfo,
    activeRoot,
    isViewing,
    filePath,
    dirPath,
  };

  return {
    state,
    setContent,
    setError,
    openEntry,
    goUp,
    handleBack,
    handleRootChange,
  };
}
