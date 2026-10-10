import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import type { FinishedMessage, Session } from '../types/chat';
import { apiFetch } from '../lib/api-fetch';
import { copyToClipboard } from '../lib/clipboard';
import { formatRelativeTime } from '../lib/formatTime';
import { UiIcon } from './UiIcon';
import './SessionPreview.css';

interface Props {
  session: Session;
  onClose: () => void;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
}

/** A saved-history peek. It never attaches to or resumes a provider session. */
export function SessionPreview({ session, onClose, onOpen, onRename, onDelete }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const restoreFocus = useRef(document.activeElement);
  const titleId = useId();
  const [messages, setMessages] = useState<{ id: string; role: string; text: string }[] | null>(
    null,
  );
  const [error, setError] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const title = session.summary || 'Untitled conversation';

  useEffect(() => {
    const dialog = dialogRef.current!;
    const previousFocus = restoreFocus.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.showModal();
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void apiFetch(`/api/sessions/${encodeURIComponent(session.id)}/messages`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Preview unavailable');
        const history: FinishedMessage[] = await response.json();
        if (!Array.isArray(history)) throw new Error('Invalid preview');
        const recent = history
          .filter(
            (message) =>
              ['user', 'assistant'].includes(message?.role) && Array.isArray(message.blocks),
          )
          .map((message) => ({
            id: message.messageId,
            role: message.role,
            text: message.blocks
              .filter((block) => block?.blockType === 'text' && typeof block.content === 'string')
              .map((block) => block.content)
              .join('\n\n'),
          }))
          .filter((message) => message.text.trim())
          .slice(-3)
          .map((message) => ({ ...message, text: message.text.slice(0, 12000) }));
        if (!controller.signal.aborted) setMessages(recent);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [session.id]);

  async function copyId() {
    const copied = await copyToClipboard(session.id);
    setCopyStatus(copied ? 'Session ID copied' : 'Couldn’t copy session ID.');
  }

  return createPortal(
    <dialog
      ref={dialogRef}
      className="session-preview"
      aria-label={`Preview ${title}`}
      aria-modal="true"
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const buttons = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>('button'),
        );
        const current = buttons.findIndex((button) => button === document.activeElement);
        const next = event.shiftKey
          ? (current - 1 + buttons.length) % buttons.length
          : (current + 1) % buttons.length;
        event.preventDefault();
        buttons[next].focus();
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="session-preview-stack">
        <section className="session-preview-card" aria-labelledby={titleId}>
          <header className="session-preview-header">
            <div>
              <h2 id={titleId}>{title}</h2>
              <p>
                {formatRelativeTime(session.lastModified)}
                {session.isActive ? ' · Active' : ''}
              </p>
            </div>
            <button type="button" aria-label="Close preview" onClick={onClose} autoFocus>
              <UiIcon name="close" size={16} />
            </button>
          </header>
          <div className="session-preview-messages" aria-busy={!messages && !error}>
            {error ? (
              <p role="status">Couldn’t load preview.</p>
            ) : messages === null ? (
              <p role="status">Loading preview…</p>
            ) : messages.length === 0 ? (
              <p>No saved messages yet.</p>
            ) : (
              messages.map((message, index) => (
                <article
                  key={`${message.id}:${index}`}
                  className={`session-preview-message session-preview-message--${message.role}`}
                >
                  <p className="session-preview-speaker">
                    {message.role === 'user' ? 'You' : 'Assistant'}
                  </p>
                  <ReactMarkdown
                    skipHtml
                    components={{
                      a: ({ children }) => <span>{children}</span>,
                      img: ({ alt }) => <span>{alt || 'Image'}</span>,
                    }}
                  >
                    {message.text}
                  </ReactMarkdown>
                </article>
              ))
            )}
          </div>
        </section>
        <div className="session-preview-actions" aria-label="Session actions">
          <button type="button" onClick={onOpen}>
            <UiIcon name="chats" />
            Open conversation
          </button>
          <button type="button" onClick={onRename}>
            <UiIcon name="edit" />
            Rename
          </button>
          <button type="button" onClick={() => void copyId()}>
            <UiIcon name="copy" />
            Copy session ID
          </button>
          {copyStatus && <p role="status">{copyStatus}</p>}
          <button type="button" className="session-preview-delete" onClick={onDelete}>
            <UiIcon name="trash" />
            Delete conversation
          </button>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
