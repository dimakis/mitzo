import { useState, useRef, useEffect } from 'react';
import { apiFetch } from '../lib/api-fetch';
import { isTelosArtifactUrl, telosDocumentUrl } from '../lib/file-paths';
import { createBrowserId } from '../lib/browser-crypto';

// Budget UTF-16 storage conservatively, including both undo and redo snapshots.
const MAX_HISTORY_BYTES = 20 * 1024 * 1024;

interface Draft {
  base: string;
  content: string;
  revision?: number;
  requestId?: string;
}
function storedDraft(key: string): Draft | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) || 'null');
    return typeof value?.base === 'string' && typeof value?.content === 'string' ? value : null;
  } catch {
    return null;
  }
}

export function useFileEditor(
  content: string,
  filePath: string,
  _onError: (msg: string) => void,
  sessionId?: string,
  artifactRevision?: number,
) {
  const telos = isTelosArtifactUrl(filePath);
  const key = `mitzo-file-draft:${JSON.stringify([telos ? '' : sessionId || '', telos ? filePath.split('?')[0] : filePath])}`;
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [draftStorageError, setDraftStorageError] = useState('');
  const [error, setError] = useState('');
  const [latestContent, setLatestContent] = useState<string | null>(null);
  const [latestRevision, setLatestRevision] = useState<number>();
  const [baseRevision, setBaseRevision] = useState(artifactRevision);
  const requestId = useRef<string | undefined>(undefined);
  const [reviewing, setReviewing] = useState(false);
  const [base, setBase] = useState(content);
  const [history, setHistory] = useState<string[]>([]);
  const [position, setPosition] = useState(0);
  const [historyResetKey, setHistoryResetKey] = useState(0);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const inFlight = useRef(false);
  const identity = useRef(key);
  identity.current = key;
  const dirty = editing && editContent !== base;

  useEffect(() => {
    identity.current = key;
    return () => {
      identity.current = '';
    };
  }, [key]);

  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);

  function persist(value: string, original = base, revision = baseRevision) {
    try {
      if (value === original) sessionStorage.removeItem(key);
      else
        sessionStorage.setItem(
          key,
          JSON.stringify({
            base: original,
            content: value,
            ...(telos ? { revision, requestId: requestId.current } : {}),
          }),
        );
      setDraftStorageError('');
    } catch {
      setDraftStorageError(
        'Latest changes are not backed up. Keep this tab open or save the document before leaving.',
      );
    }
  }
  function startEditing() {
    const draft = storedDraft(key);
    const value = draft?.content ?? content;
    setBase(draft?.base ?? content);
    setBaseRevision(draft?.revision ?? artifactRevision);
    requestId.current = typeof draft?.requestId === 'string' ? draft.requestId : undefined;
    setEditContent(value);
    setHistory([value]);
    setPosition(0);
    setError(draft ? 'Recovered your unsaved draft.' : '');
    setEditing(true);
    requestAnimationFrame(() => editorRef.current?.focus());
  }
  function handleEditChange(value: string) {
    if (inFlight.current || value === editContent) return;
    const next = [...history.slice(0, position + 1), value].slice(-100);
    let bytes = next.reduce((total, snapshot) => total + snapshot.length * 2, 0);
    while (next.length > 1 && bytes > MAX_HISTORY_BYTES) bytes -= next.shift()!.length * 2;
    setHistory(next);
    setPosition(next.length - 1);
    setEditContent(value);
    requestId.current = undefined;
    persist(value);
  }
  function moveHistory(next: number) {
    if (inFlight.current || next < 0 || next >= history.length) return;
    setPosition(next);
    setEditContent(history[next]);
    requestId.current = undefined;
    persist(history[next]);
  }
  function resetEditor() {
    if (inFlight.current) return;
    persist(base);
    setEditing(false);
    setError('');
  }
  function cancelEditing() {
    if (inFlight.current || (dirty && !confirm('Discard unsaved changes?'))) return;
    persist(base);
    resetEditor();
  }
  async function reviewLatest() {
    if (inFlight.current || reviewing) return;
    setReviewing(true);
    const requestKey = key;
    try {
      const query = new URLSearchParams({ path: filePath });
      if (sessionId) query.set('sessionId', sessionId);
      const response = await apiFetch(
        telos ? telosDocumentUrl(filePath, true) : `/api/files/read?${query}`,
      );
      if (!response.ok)
        throw new Error('Could not load the latest version. Your draft is preserved.');
      const data = await response.json();
      if (typeof data.content !== 'string') throw new Error('Invalid document response');
      if (telos && (!Number.isSafeInteger(data.revision) || data.revision < 1))
        throw new Error('Invalid document revision');
      if (identity.current !== requestKey) return;
      setLatestContent(data.content);
      setLatestRevision(data.revision);
    } catch (error) {
      if (identity.current === requestKey)
        setError(error instanceof Error ? error.message : 'Could not load document');
    } finally {
      setReviewing(false);
    }
  }
  function resolveConflict(replaceDraft: boolean, onLatest?: (content: string) => void) {
    if (inFlight.current || latestContent === null) return;
    const next = replaceDraft ? latestContent : editContent;
    setBase(latestContent);
    setBaseRevision(latestRevision);
    requestId.current = undefined;
    setEditContent(next);
    setHistory([next]);
    setPosition(0);
    setHistoryResetKey((value) => value + 1);
    persist(next, latestContent, latestRevision);
    onLatest?.(latestContent);
    setLatestContent(null);
    setError('');
  }
  async function saveFile(onSaved: (newContent: string, savedPath?: string) => void) {
    if (inFlight.current || !dirty) return;
    inFlight.current = true;
    setSaving(true);
    setError('');
    const requestKey = key;
    try {
      if (telos) {
        if (!Number.isSafeInteger(baseRevision) || baseRevision! < 1)
          throw new Error('Reload the saved document before editing. Your draft is preserved.');
        requestId.current ??= createBrowserId();
        persist(editContent);
      }
      const res = await apiFetch(telos ? telosDocumentUrl(filePath, true) : '/api/files/write', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          telos
            ? { content: editContent, expectedRevision: baseRevision, requestId: requestId.current }
            : {
                path: filePath,
                content: editContent,
                expectedContent: base,
                sessionId,
              },
        ),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Save failed' }));
        throw new Error(data.error || 'Save failed');
      }
      let savedPath: string | undefined;
      if (telos) {
        const { artifact } = await res.json();
        const baseUrl = filePath.split('?')[0];
        if (
          !Number.isSafeInteger(artifact?.revision) ||
          artifact.revision <= baseRevision! ||
          artifact.url !== `${baseUrl}?revision=${artifact.revision}`
        )
          throw new Error(
            'Save confirmation unavailable. Your draft is preserved; try saving again.',
          );
        savedPath = artifact.url;
        if (identity.current !== requestKey) return;
        setBaseRevision(artifact.revision);
      }
      if (identity.current !== requestKey) return;
      try {
        sessionStorage.removeItem(requestKey);
        setDraftStorageError('');
      } catch {
        /* Storage may be disabled. */
      }
      if (identity.current !== requestKey) return;
      if (savedPath) onSaved(editContent, savedPath);
      else onSaved(editContent);
      setBase(editContent);
      requestId.current = undefined;
    } catch (err: unknown) {
      if (identity.current === requestKey)
        setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }
  return {
    historyResetKey,
    draftStorageError,
    latestContent,
    reviewing,
    reviewLatest,
    resolveConflict,
    editing,
    editContent,
    saving,
    dirty,
    error,
    editorRef,
    startEditing,
    handleEditChange,
    cancelEditing,
    saveFile,
    resetEditor,
    undo: () => moveHistory(position - 1),
    redo: () => moveHistory(position + 1),
    canUndo: position > 0,
    canRedo: position < history.length - 1,
  };
}
