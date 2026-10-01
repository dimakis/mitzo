import { useState, useRef, useEffect } from 'react';
import { apiFetch } from '../lib/api-fetch';

interface Draft {
  base: string;
  content: string;
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
) {
  const key = `mitzo-file-draft:${JSON.stringify([sessionId || '', filePath])}`;
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [latestContent, setLatestContent] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [base, setBase] = useState(content);
  const [history, setHistory] = useState<string[]>([]);
  const [position, setPosition] = useState(0);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const inFlight = useRef(false);
  const identity = useRef(key);
  identity.current = key;
  const dirty = editing && editContent !== base;

  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);

  function persist(value: string, original = base) {
    try {
      if (value === original) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, JSON.stringify({ base: original, content: value }));
    } catch {
      /* Editing remains available when storage is full or disabled. */
    }
  }
  function startEditing() {
    const draft = storedDraft(key);
    const value = draft?.content ?? content;
    setBase(draft?.base ?? content);
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
    setHistory(next);
    setPosition(next.length - 1);
    setEditContent(value);
    persist(value);
  }
  function moveHistory(next: number) {
    if (inFlight.current || next < 0 || next >= history.length) return;
    setPosition(next);
    setEditContent(history[next]);
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
    try {
      const query = new URLSearchParams({ path: filePath });
      if (sessionId) query.set('sessionId', sessionId);
      const response = await apiFetch(`/api/files/read?${query}`);
      if (!response.ok)
        throw new Error('Could not load the latest version. Your draft is preserved.');
      const data = await response.json();
      if (typeof data.content !== 'string') throw new Error('Invalid document response');
      setLatestContent(data.content);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not load document');
    } finally {
      setReviewing(false);
    }
  }
  function resolveConflict(replaceDraft: boolean, onLatest?: (content: string) => void) {
    if (inFlight.current || latestContent === null) return;
    const next = replaceDraft ? latestContent : editContent;
    setBase(latestContent);
    setEditContent(next);
    setHistory([next]);
    setPosition(0);
    persist(next, latestContent);
    onLatest?.(latestContent);
    setLatestContent(null);
    setError('');
  }
  async function saveFile(onSaved: (newContent: string) => void) {
    if (inFlight.current || !dirty) return;
    inFlight.current = true;
    setSaving(true);
    setError('');
    const requestKey = key;
    try {
      const res = await apiFetch('/api/files/write', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: filePath,
          content: editContent,
          expectedContent: base,
          sessionId,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Save failed' }));
        throw new Error(data.error || 'Save failed');
      }
      try {
        sessionStorage.removeItem(requestKey);
      } catch {
        /* Storage may be disabled. */
      }
      if (identity.current !== requestKey) return;
      onSaved(editContent);
      setBase(editContent);
    } catch (err: unknown) {
      if (identity.current === requestKey)
        setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }
  return {
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
