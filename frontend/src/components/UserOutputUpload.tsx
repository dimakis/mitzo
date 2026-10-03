import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../lib/api-fetch';

export function UserOutputUpload({ itemId, onUploaded }: { itemId: string; onUploaded(): void }) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(crypto.randomUUID());
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  async function upload() {
    if (!file || busy) return;
    setError(null);
    setMessage(null);
    if (file.size > 5 * 1024 * 1024) {
      setError('File exceeds 5 MB.');
      return;
    }
    setBusy(true);
    const current = new AbortController();
    controller.current = current;
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Unable to read this file.'));
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
        reader.readAsDataURL(file);
      });
      if (current.signal.aborted) return;
      const response = await apiFetch(
        `/api/telos/items/${encodeURIComponent(itemId)}/artifacts/upload`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: current.signal,
          body: JSON.stringify({
            filename: file.name,
            title: title.trim() || file.name,
            requestId: requestId.current,
            base64,
          }),
        },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Upload failed. Your file is preserved.');
      if (current.signal.aborted) return;
      setMessage(`Saved revision ${data.artifact.revision}.`);
      requestId.current = crypto.randomUUID();
      onUploaded();
    } catch (failure) {
      if (!current.signal.aborted)
        setError(
          failure instanceof Error ? failure.message : 'Upload failed. Your file is preserved.',
        );
    } finally {
      if (!current.signal.aborted) setBusy(false);
    }
  }

  return (
    <form
      className="todo-output-upload"
      onSubmit={(event) => {
        event.preventDefault();
        void upload();
      }}
    >
      <p>
        Upload a non-sensitive work output for this item. Using the same filename saves a new
        revision. Maximum 5 MB. Credentials and private financial or health documents belong in
        private case storage.
      </p>
      <label>
        File to upload
        <input
          type="file"
          disabled={busy}
          accept=".txt,.md,.csv,.json,.pdf,.png,.jpg,.jpeg,.webp,.docx,.xlsx"
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            event.target.value = '';
            setError(null);
            setMessage(null);
            requestId.current = crypto.randomUUID();
          }}
        />
      </label>
      {file && <p>Selected file: {file.name}</p>}
      <label>
        File title (optional)
        <input
          type="text"
          value={title}
          disabled={busy}
          maxLength={200}
          onChange={(event) => {
            setTitle(event.target.value);
            requestId.current = crypto.randomUUID();
          }}
        />
      </label>
      <button type="submit" disabled={!file || busy}>
        {busy ? 'Uploading…' : 'Upload file'}
      </button>
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
