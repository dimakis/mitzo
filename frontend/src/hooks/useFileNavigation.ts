import { useState, useEffect, useRef } from 'react';
import { LocalCodexFirstCommandSchema, OrdinaryWorkspaceFirstCommandSchema } from '@mitzo/protocol';
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

type WorkspaceKind = 'ordinary' | 'repository' | 'unknown';
interface ScopedWorkspace {
  scope: string;
  owner: object;
  kind: WorkspaceKind;
  gitInfo: GitInfo | null;
  roots: FileRoot[];
  worktreesLoading: boolean;
  worktreesError: string;
}
const emptyWorkspace = (scope: string, owner: object): ScopedWorkspace => ({
  scope,
  owner,
  kind: 'unknown',
  gitInfo: null,
  roots: [],
  worktreesLoading: false,
  worktreesError: '',
});

export interface FileNavState {
  content: string;
  ext: string;
  entries: DirEntry[];
  currentDir: string;
  canGoUp: boolean;
  loading: boolean;
  error: string;
  gitInfo: GitInfo | null;
  canLoadWorktrees: boolean;
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
  const navigationScope = JSON.stringify([sessionId, telos]);
  const navigationOwner = useRef({ scope: navigationScope });
  if (navigationOwner.current.scope !== navigationScope)
    navigationOwner.current = { scope: navigationScope };
  const navigationToken = navigationOwner.current;
  const [workspace, setWorkspace] = useState(() =>
    emptyWorkspace(navigationScope, navigationToken),
  );
  const selectedWorkspace = workspace.owner === navigationToken ? workspace : null;
  const gitInfo = selectedWorkspace?.gitInfo ?? null;
  const roots =
    selectedWorkspace && selectedWorkspace.kind !== 'unknown' ? selectedWorkspace.roots : [];
  const canLoadWorktrees = selectedWorkspace?.kind === 'repository';
  const worktreesLoading = selectedWorkspace?.worktreesLoading ?? false;
  const worktreesError = selectedWorkspace?.worktreesError ?? '';
  const classification = useRef<{ scope: string; promise: Promise<WorkspaceKind> } | null>(null);
  const worktreeRequest = useRef<{
    owner: object;
    classification: object;
    promise: Promise<void>;
  } | null>(null);
  // With session authority the server defaults to that session's workspace.
  // Only an explicitly selected root should override it.
  const activeRoot = rootParam || (sessionId ? '' : gitInfo?.repoPath || '');
  const resourceScope = JSON.stringify([identity, dirPath, activeRoot]);
  const resourceOwner = useRef({ scope: resourceScope });
  if (resourceOwner.current.scope !== resourceScope)
    resourceOwner.current = { scope: resourceScope };
  const resourceToken = resourceOwner.current;
  const [loadedToken, setLoadedToken] = useState<object | null>(null);
  const currentResource = loadedToken === resourceToken;
  const canGoUp = Boolean(
    currentResource &&
    currentDir &&
    browserRoot &&
    currentDir !== browserRoot &&
    currentDir.startsWith(`${browserRoot.replace(/\/$/, '')}/`),
  );

  useEffect(() => {
    navigationOwner.current = navigationToken;
    let disposed = false;
    setWorkspace(emptyWorkspace(navigationScope, navigationToken));
    const apply = (
      patch: Partial<ScopedWorkspace> | ((previous: ScopedWorkspace) => Partial<ScopedWorkspace>),
    ) => {
      if (disposed || navigationOwner.current !== navigationToken) return;
      setWorkspace((previous) => {
        if (disposed || navigationOwner.current !== navigationToken) return previous;
        const owned =
          previous.owner === navigationToken
            ? previous
            : emptyWorkspace(navigationScope, navigationToken);
        return { ...owned, ...(typeof patch === 'function' ? patch(owned) : patch) };
      });
    };
    const classify = async (): Promise<WorkspaceKind> => {
      if (telos) return 'unknown';
      if (!sessionId) return 'repository';
      try {
        const response = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/meta`);
        if (!response.ok) return 'unknown';
        const body = await response.json();
        if (
          !body ||
          typeof body !== 'object' ||
          Array.isArray(body) ||
          body.sessionId !== sessionId
        )
          return 'unknown';
        if (body.ordinaryWorkspaceId != null) {
          const id =
            OrdinaryWorkspaceFirstCommandSchema.shape.workspace.shape.workspaceId.safeParse(
              body.ordinaryWorkspaceId,
            );
          return id.success && body.repositoryWorkspaceId == null ? 'ordinary' : 'unknown';
        }
        if (body.runtimeCommandScope === 'prepared-first-command') return 'unknown';
        if (body.repositoryWorkspaceId != null)
          return LocalCodexFirstCommandSchema.shape.repositoryWorkspaceId.safeParse(
            body.repositoryWorkspaceId,
          ).success
            ? 'repository'
            : 'unknown';
        // A bound runtime without its workspace identity is not legacy Git scope.
        if (
          body.repositoryWorkspaceId == null &&
          (body.runtimeBinding != null || body.runtimeCommandScope != null)
        )
          return 'unknown';
        return 'repository';
      } catch {
        return 'unknown';
      }
    };
    const promise = classify();
    classification.current = { scope: navigationScope, promise };
    void promise.then((kind) => {
      if (disposed || navigationOwner.current !== navigationToken) return;
      apply({ kind });
      if (kind !== 'repository') return;
      void apiFetch('/api/git/info')
        .then((response) => (response.ok ? response.json() : null))
        .then((data: GitInfo | null) => {
          if (data) apply((previous) => ({ gitInfo: previous.gitInfo ?? data }));
        })
        .catch(() => {
          /* Optional legacy Git metadata never supplies ordinary scope. */
        });
    });
    if (!telos) {
      const params = new URLSearchParams();
      if (sessionId) params.set('sessionId', sessionId);
      void apiFetch(`/api/files/roots${params.size ? '?' + params.toString() : ''}`)
        .then((response) => (response.ok ? response.json() : []))
        .then((data: FileRoot[]) => {
          if (Array.isArray(data)) apply({ roots: data });
        })
        .catch(() => {
          /* Scoped directory/file reads expose actionable errors. */
        });
    }
    return () => {
      disposed = true;
      if (navigationOwner.current === navigationToken) navigationOwner.current = { scope: '' };
    };
  }, [navigationToken, navigationScope, sessionId, telos]);

  useEffect(() => {
    resourceOwner.current = resourceToken;
    let disposed = false;
    setLoading(true);
    setError('');
    setContent('');
    setExt('');
    setEntries([]);
    setCurrentDir('');
    setBrowserRoot('');
    setDisplayName('');
    setPreviewUnavailable(false);
    setArtifactRevision(undefined);
    setArtifactEditable(false);

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
          if (disposed || resourceOwner.current !== resourceToken) return;
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
          if (!disposed && resourceOwner.current === resourceToken) setError(err.message);
        })
        .finally(() => {
          if (!disposed && resourceOwner.current === resourceToken) {
            setLoadedToken(resourceToken);
            setLoading(false);
          }
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
          if (disposed || resourceOwner.current !== resourceToken) return;
          setEntries(data.entries);
          setCurrentDir(data.dir);
          setBrowserRoot(data.root);
        })
        .catch((err) => {
          if (!disposed && resourceOwner.current === resourceToken) setError(err.message);
        })
        .finally(() => {
          if (!disposed && resourceOwner.current === resourceToken) {
            setLoadedToken(resourceToken);
            setLoading(false);
          }
        });
    }
    return () => {
      disposed = true;
      if (resourceOwner.current === resourceToken) resourceOwner.current = { scope: '' };
    };
  }, [
    resourceToken,
    resourceScope,
    identity,
    filePath,
    dirPath,
    isViewing,
    activeRoot,
    sessionId,
    telos,
  ]);

  async function loadWorktrees(): Promise<void> {
    const selected = classification.current;
    if (selected?.scope !== navigationScope || navigationOwner.current !== navigationToken) return;
    if (
      (await selected.promise) !== 'repository' ||
      navigationOwner.current !== navigationToken ||
      classification.current !== selected
    )
      return;
    if (workspace.owner === navigationToken && workspace.gitInfo?.worktreesLoaded) return;
    if (
      worktreeRequest.current?.owner === navigationToken &&
      worktreeRequest.current.classification === selected
    )
      return worktreeRequest.current.promise;
    const updateWorkspace = (patch: Partial<ScopedWorkspace>) => {
      if (navigationOwner.current !== navigationToken || classification.current !== selected)
        return;
      setWorkspace((previous) =>
        previous.owner === navigationToken ? { ...previous, ...patch } : previous,
      );
    };
    updateWorkspace({ worktreesLoading: true, worktreesError: '' });
    const request = apiFetch('/api/git/info?worktrees=1')
      .then(async (response) => {
        if (!response.ok) throw new Error('Failed to load worktrees');
        const data: GitInfo = await response.json();
        updateWorkspace({
          gitInfo: data,
          worktreesError:
            data.worktreesLoaded === true ? '' : 'Some worktrees could not be loaded. Try again.',
        });
      })
      .catch(() => updateWorkspace({ worktreesError: 'Failed to load worktrees' }))
      .finally(() => {
        updateWorkspace({ worktreesLoading: false });
        if (worktreeRequest.current?.promise === request) worktreeRequest.current = null;
      });
    worktreeRequest.current = {
      owner: navigationToken,
      classification: selected,
      promise: request,
    };
    return request;
  }

  function navigationParams(): Record<string, string> {
    const params: Record<string, string> = {};
    if (activeRoot) params.root = activeRoot;
    if (sessionId) params.sessionId = sessionId;
    return params;
  }

  function openEntry(entry: DirEntry, dirty: boolean) {
    if (!currentResource || resourceOwner.current !== resourceToken) return;
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
    if (resourceOwner.current !== resourceToken) return;
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
    if (resourceOwner.current !== resourceToken) return;
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
    if (navigationOwner.current !== navigationToken) return;
    if (dirty && !confirm('Discard unsaved changes?')) return;
    const params: Record<string, string> = {};
    if (newRoot) params.root = newRoot;
    if (sessionId) params.sessionId = sessionId;
    setSearchParams(params);
  }

  const state: FileNavState = {
    content: currentResource ? content : '',
    ext: currentResource ? ext : '',
    entries: currentResource ? entries : [],
    currentDir: currentResource ? currentDir : '',
    canGoUp,
    loading: !currentResource || loading,
    error: currentResource ? error : '',
    gitInfo,
    canLoadWorktrees,
    worktreesLoading,
    worktreesError,
    roots,
    activeRoot,
    isViewing,
    filePath: openedPath,
    displayName: currentResource ? displayName : '',
    previewUnavailable: currentResource && previewUnavailable,
    artifactRevision: currentResource ? artifactRevision : undefined,
    artifactEditable: currentResource && artifactEditable,
    dirPath,
    sessionId,
  };

  return {
    state,
    setContent: (content: string, savedPath?: string) => {
      if (!currentResource || resourceOwner.current !== resourceToken) return;
      setContent(content);
      if (telos && savedPath) {
        const params = new URLSearchParams(searchParams);
        params.set('path', savedPath);
        setSearchParams(params, { replace: true });
      }
    },
    setError: (message: string) => {
      if (resourceOwner.current === resourceToken) setError(message);
    },
    openEntry,
    goUp,
    handleBack,
    handleRootChange,
    loadWorktrees,
  };
}
