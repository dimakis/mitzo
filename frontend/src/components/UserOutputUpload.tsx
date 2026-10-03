import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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

  const [opened, setOpened] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const drawer = useRef<HTMLElement>(null);
  const titleId = useId();
  useLayoutEffect(() => {
    if (!opened) return;
    const opener = trigger.current;
    const overflow = document.body.style.overflow;
    const root = document.getElementById('root');
    const inert = root?.inert ?? false;
    document.body.style.overflow = 'hidden';
    if (root) root.inert = true;
    close.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      if (root) root.inert = inert;
      if (opener?.isConnected) opener.focus();
    };
  }, [opened]);
  useEffect(() => {
    if (opened && drawer.current && !drawer.current.contains(document.activeElement))
      close.current?.focus();
  });

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
      setOpened(false);
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
    <div className="output-upload-control">
      <button
        ref={trigger}
        type="button"
        className="output-action output-upload-trigger"
        aria-haspopup="dialog"
        aria-expanded={opened}
        onClick={() => setOpened(true)}
      >
        <span aria-hidden="true">＋</span> Upload
      </button>
      {message && (
        <p className="output-upload-confirmation" role="status">
          {message}
        </p>
      )}
      {!opened && busy && <p role="status">Uploading…</p>}
      {!opened && error && (
        <p className="output-upload-error" role="alert">
          {error}
        </p>
      )}
      {opened &&
        createPortal(
          <div
            className="access-drawer-overlay output-upload-overlay"
            onClick={(event) => {
              if (event.target === event.currentTarget) setOpened(false);
            }}
          >
            <section
              ref={drawer}
              className="access-drawer output-upload-drawer"
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setOpened(false);
                  return;
                }
                if (event.key !== 'Tab') return;
                const focusable = Array.from(
                  drawer.current?.querySelectorAll<HTMLElement>(
                    'button:not([disabled]),input:not([disabled]):not([type="file"]),[tabindex="0"]',
                  ) ?? [],
                );
                const first = focusable[0],
                  last = focusable[focusable.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                  event.preventDefault();
                  last?.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                  event.preventDefault();
                  first?.focus();
                }
              }}
            >
              <header className="access-drawer-heading">
                <div>
                  <p className="workspace-eyebrow">Saved work</p>
                  <h2 id={titleId}>Upload output</h2>
                </div>
                <button
                  ref={close}
                  type="button"
                  className="access-drawer-close"
                  aria-label="Close upload"
                  onClick={() => setOpened(false)}
                >
                  ×
                </button>
              </header>
              <form
                className="output-upload-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void upload();
                }}
              >
                <div className="access-drawer-body output-upload-body">
                  <p className="output-upload-intro">
                    Add a non-sensitive work document to this item.
                  </p>
                  <div className="output-upload-file-card">
                    <span className="output-file-icon" aria-hidden="true">
                      ↑
                    </span>
                    <strong>{file ? file.name : 'Choose a file'}</strong>
                    <p>
                      {file
                        ? `${file.size.toLocaleString()} bytes · Ready to upload`
                        : 'Documents and images · Up to 5 MB'}
                    </p>
                    <button
                      className="output-action"
                      type="button"
                      disabled={busy}
                      onClick={() => picker.current?.click()}
                    >
                      {file ? 'Change file' : 'Choose file'}
                    </button>
                    <input
                      ref={picker}
                      aria-label="File to upload"
                      className="output-upload-picker"
                      type="file"
                      tabIndex={-1}
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
                    {file && (
                      <span className="output-upload-selection">Selected file: {file.name}</span>
                    )}
                  </div>
                  <label className="output-upload-title">
                    File title (optional)
                    <input
                      type="text"
                      value={title}
                      disabled={busy}
                      maxLength={200}
                      placeholder="Use the filename"
                      onChange={(event) => {
                        setTitle(event.target.value);
                        requestId.current = crypto.randomUUID();
                      }}
                    />
                  </label>
                  <p className="output-upload-note">The same filename saves a new revision.</p>
                  <p className="output-upload-privacy">
                    Credentials and private financial or health documents belong in private case
                    storage.
                  </p>
                  {error && (
                    <p className="output-upload-error" role="alert">
                      {error}
                    </p>
                  )}
                </div>
                <footer className="output-upload-footer">
                  <button
                    className="output-action output-upload-submit"
                    type="submit"
                    disabled={!file || busy}
                  >
                    {busy ? 'Uploading…' : 'Upload file'}
                  </button>
                </footer>
              </form>
            </section>
          </div>,
          document.body,
        )}
    </div>
  );
}
