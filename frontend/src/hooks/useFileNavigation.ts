import { useState, useEffect, useRef } from 'react';
import type { SetURLSearchParams } from 'react-router-dom';
import { apiFetch } from '../lib/api-fetch';
import { artifactApiUrl, isTelosArtifactUrl, telosDocumentUrl } from '../lib/file-paths';

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
  worktreesLoaded?: boolean;
}

interface FileRoot {
  label: string;
  path: string;
}

export interface FileNavState {
  content: string;
  ext: string;
  entries: DirEntry[];
  currentDir: string;
  canGoUp: boolean;
  loading: boolean;
  error: string;
  gitInfo: GitInfo | null;
  worktreesLoading: boolean;
  worktreesError: string;
  roots: FileRoot[];
  activeRoot: string;
  isViewing: boolean;
  filePath: string;
  displayName?: string;
  previewUnavailable?: boolean;
  artifactRevision?: number;
  artifactEditable?: boolean;
  dirPath: string;
  sessionId: string;
}

export function useFileNavigation(
  searchParams: URLSearchParams,
  setSearchParams: SetURLSearchParams,
) {
  const filePath = searchParams.get('path') || '';
  const telos = isTelosArtifactUrl(filePath);
  const [displayName, setDisplayName] = useState('');
  const [previewUnavailable, setPreviewUnavailable] = useState(false);
  const [artifactRevision, setArtifactRevision] = useState<number>();
  const [artifactEditable, setArtifactEditable] = useState(false);
  const dirPath = searchParams.get('dir') || '';
  const rootParam = searchParams.get('root') || '';
  const sessionId = searchParams.get('sessionId') || '';
  const isViewing = !!filePath;
  const identity = JSON.stringify([filePath, sessionId]);
  const [resolvedFile, setResolvedFile] = useState<{ identity: string; path: string } | null>(null);
  const openedPath = resolvedFile?.identity === identity ? resolvedFile.path : filePath;

  const [content, setContent] = useState('');
  const [ext, setExt] = useState('');
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [currentDir, setCurrentDir] = useState('');
  const [browserRoot, setBrowserRoot] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);
  const [roots, setRoots] = useState<FileRoot[]>([]);
  const [worktreesLoading, setWorktreesLoading] = useState(false);
  const [worktreesError, setWorktreesError] = useState('');
  const worktreeRequest = useRef<Promise<void> | null>(null);
  const worktreesLoaded = useRef(false);
  // With session authority the server defaults to that session's workspace.
  // Only an explicitly selected root should override it.
  const activeRoot = rootParam || (sessionId ? '' : gitInfo?.repoPath || '');
  const canGoUp = Boolean(
    currentDir &&
    browserRoot &&
    currentDir !== browserRoot &&
    currentDir.startsWith(`${browserRoot.replace(/\/$/, '')}/`),
  );

  useEffect(() => {
    if (telos) return;
    let disposed = false;
    apiFetch('/api/git/info')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: GitInfo | null) => {
        if (data && !disposed) {
          setGitInfo((current) => current ?? data);
        }
      })
      .catch(() => {
        // Network error loading git info — non-fatal
      });

    apiFetch('/api/files/roots')
      .then((r) => (r.ok ? r.json() : []))
      .then((data: FileRoot[]) => {
        if (!disposed && Array.isArray(data)) setRoots(data);
      })
      .catch(() => {
        // Network error loading roots — non-fatal
      });
    return () => {
      disposed = true;
    };
  }, [telos]);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError('');

    const directoryParams = new URLSearchParams({ dir: dirPath });
    if (activeRoot) directoryParams.set('root', activeRoot);
    if (sessionId) directoryParams.set('sessionId', sessionId);

    if (isViewing) {
      const read = apiFetch(
        telos
          ? telosDocumentUrl(filePath)
          : artifactApiUrl('read', filePath, sessionId || undefined),
      ).then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => null);
          throw new Error(body?.error || 'Failed to load file');
        }
        return r.json();
      });
      read
        .then((data) => {
          if (disposed) return;
          setResolvedFile({
            identity,
            path: typeof data.path === 'string' && data.path ? data.path : filePath,
          });
          setDisplayName(typeof data.name === 'string' ? data.name : '');
          setPreviewUnavailable(Boolean(data.previewUnavailable));
          setArtifactRevision(telos ? data.revision : undefined);
          setArtifactEditable(telos && data.editable === true);
          setContent(data.content);
          setExt(data.ext);
        })
        .catch((err) => {
          if (!disposed) setError(err.message);
        })
        .finally(() => {
          if (!disposed) setLoading(false);
        });
    } else {
      apiFetch(`/api/files?${directoryParams.toString()}`)
        .then(async (r) => {
          if (!r.ok) {
            const body = await r.json().catch(() => null);
            throw new Error(body?.error || 'Failed to load directory');
          }
          return r.json();
        })
        .then((data) => {
          if (disposed) return;
          setEntries(data.entries);
          setCurrentDir(data.dir);
          setBrowserRoot(data.root);
        })
        .catch((err) => {
          if (!disposed) setError(err.message);
        })
        .finally(() => {
          if (!disposed) setLoading(false);
        });
    }
    return () => {
      disposed = true;
    };
  }, [identity, filePath, dirPath, isViewing, activeRoot, sessionId, telos]);

  function loadWorktrees(): Promise<void> {
    if (worktreesLoaded.current) return Promise.resolve();
    if (worktreeRequest.current) return worktreeRequest.current;
    setWorktreesLoading(true);
    setWorktreesError('');
    const request = apiFetch('/api/git/info?worktrees=1')
      .then(async (response) => {
        if (!response.ok) throw new Error('Failed to load worktrees');
        const data: GitInfo = await response.json();
        setGitInfo(data);
        worktreesLoaded.current = data.worktreesLoaded === true;
        if (!worktreesLoaded.current)
          setWorktreesError('Some worktrees could not be loaded. Try again.');
      })
      .catch(() => setWorktreesError('Failed to load worktrees'))
      .finally(() => {
        setWorktreesLoading(false);
        worktreeRequest.current = null;
      });
    worktreeRequest.current = request;
    return request;
  }

  function navigationParams(): Record<string, string> {
    const params: Record<string, string> = {};
    if (activeRoot) params.root = activeRoot;
    if (sessionId) params.sessionId = sessionId;
    return params;
  }

  function openEntry(entry: DirEntry, dirty: boolean) {
    if (dirty && !confirm('Discard unsaved changes?')) return;
    const full = currentDir ? `${currentDir}/${entry.name}` : entry.name;
    const params = navigationParams();
    if (entry.isDir) {
      params.dir = full;
    } else {
      params.path = full;
    }
    setSearchParams(params);
  }

  function goUp(dirty: boolean) {
    if (dirty && !confirm('Discard unsaved changes?')) return;
    if (!canGoUp) return;
    const parent = currentDir.replace(/\/[^/]+$/, '');
    const params = navigationParams();
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
      if (telos) {
        setSearchParams({});
        return;
      }
      const lastSlash = openedPath.lastIndexOf('/');
      const parentDir = lastSlash < 0 ? '' : openedPath.slice(0, lastSlash) || '/';
      const params = navigationParams();
      if (parentDir) params.dir = parentDir;
      setSearchParams(params);
      setContent('');
      setExt('');
    } else if (canGoUp) {
      goUp(false);
    }
  }

  function handleRootChange(newRoot: string, dirty: boolean) {
    if (dirty && !confirm('Discard unsaved changes?')) return;
    const params: Record<string, string> = {};
    if (newRoot) params.root = newRoot;
    if (sessionId) params.sessionId = sessionId;
    setSearchParams(params);
  }

  const state: FileNavState = {
    content,
    ext,
    entries,
    currentDir,
    canGoUp,
    loading,
    error,
    gitInfo,
    worktreesLoading,
    worktreesError,
    roots,
    activeRoot,
    isViewing,
    filePath: openedPath,
    displayName,
    previewUnavailable,
    artifactRevision,
    artifactEditable,
    dirPath,
    sessionId,
  };

  return {
    state,
    setContent: (content: string, savedPath?: string) => {
      setContent(content);
      if (telos && savedPath) {
        const params = new URLSearchParams(searchParams);
        params.set('path', savedPath);
        setSearchParams(params, { replace: true });
      }
    },
    setError,
    openEntry,
    goUp,
    handleBack,
    handleRootChange,
    loadWorktrees,
  };
}
