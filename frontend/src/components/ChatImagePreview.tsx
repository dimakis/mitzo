import { useState } from 'react';
import { HomeDialog } from './HomeDialog';
import '../styles/image-attachment-editor.css';
import '../styles/chat-image-preview.css';

/** Reuse the draft preview's fullscreen surface without editing a sent attachment. */
export function ChatImagePreview({
  src,
  attachment,
  onClose,
}: {
  src: string;
  attachment: number;
  onClose(): void;
}) {
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>('loading');
  const [attempt, setAttempt] = useState(0);
  return (
    <HomeDialog
      title="Image preview"
      className="image-attachment-editor chat-image-preview"
      onClose={onClose}
      isolatePointerEvents
      containFocus
    >
      <div className="image-editor-stage" aria-busy={state === 'loading'}>
        <img
          key={attempt}
          className="chat-image-preview-image"
          src={src}
          alt={`Attachment ${attachment}`}
          onLoad={() => setState('loaded')}
          onError={() => {
            setState('failed');
            console.warn('[mitzo] Chat image preview failed', {
              code: 'chat_image_preview_load_failed',
              stage: 'load',
              attachment,
              attempt,
            });
          }}
        />
      </div>
      {state !== 'loaded' && (
        <div className="image-editor-status" aria-live="polite">
          {state === 'failed' ? (
            <p role="alert">This image could not be loaded. Try again or close the preview.</p>
          ) : (
            <p role="status">Loading image…</p>
          )}
        </div>
      )}
      {state === 'failed' && (
        <footer>
          <button
            type="button"
            className="home-secondary"
            onClick={(event) => {
              // Retry disappears while loading; retain a stable modal focus target.
              event.currentTarget
                .closest('dialog')
                ?.querySelector<HTMLButtonElement>('button[aria-label="Close"]')
                ?.focus({ preventScroll: true });
              setState('loading');
              setAttempt((value) => value + 1);
            }}
          >
            Retry image
          </button>
        </footer>
      )}
    </HomeDialog>
  );
}
