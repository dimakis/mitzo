import { useState, useRef, useCallback } from 'react';
import { apiFetch } from '../lib/api-fetch';

export function useFileEditor(content: string, filePath: string, onError: (msg: string) => void) {
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);

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

  async function saveFile(onSaved: (newContent: string) => void) {
    setSaving(true);
    try {
      const res = await apiFetch('/api/files/write', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, content: editContent }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Save failed' }));
        throw new Error(data.error || 'Save failed');
      }
      onSaved(editContent);
      setEditing(false);
      setDirty(false);
    } catch (err: unknown) {
      onError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  function resetEditor() {
    setEditing(false);
    setDirty(false);
  }

  return {
    editing,
    editContent,
    saving,
    dirty,
    editorRef,
    startEditing,
    handleEditChange,
    cancelEditing,
    saveFile,
    resetEditor,
  };
}
