import { useEffect, useId, useRef, useState } from 'react';
import type { QueuedMessage } from '../hooks/useQueuedMessages';
import { chatStorage } from '../lib/large-chat-storage';
import { HomeDialog } from './HomeDialog';
import { MotionPresence } from './MotionPresence';
import { UiIcon } from './UiIcon';
import './QueuedDraftTray.css';
export function QueuedDraftTray({
  queue,
  paused,
  busy,
  running,
  blocked,
  recoveryBlocked = blocked,
  textOnlySteer,
  onPause,
  onSend,
  onUpdate,
  onRemove,
  onEditingChange,
}: {
  queue: QueuedMessage[];
  paused: boolean;
  busy: boolean;
  running: boolean;
  blocked: boolean;
  recoveryBlocked?: boolean;
  textOnlySteer: boolean;
  onPause(): void;
  onSend(index: number): void;
  onUpdate(index: number, message: QueuedMessage, position: number): boolean;
  onRemove(index: number): void;
  onEditingChange(open: boolean): void;
}) {
  const [expanded, setExpanded] = useState(true),
    [editor, setEditor] = useState<{
      id?: string;
      index: number;
      message: QueuedMessage;
      text: string;
      position: number;
    } | null>(null),
    [error, setError] = useState('');
  const activeEditor = useRef(editor);
  activeEditor.current = editor;
  const id = useId();
  const editing = !!editor;
  useEffect(() => {
    onEditingChange(editing);
    return () => onEditingChange(false);
  }, [editing, onEditingChange]);
  if (!queue.length && !editor) return null;
  const editIndex = editor
    ? queue.findIndex((item, index) =>
        editor.id ? item.queueEntryId === editor.id : index === editor.index,
      )
    : -1;
  const close = () => {
    setEditor(null);
    setError('');
  };
  return (
    <section role="region" className="queued-draft-tray" aria-label="Up next">
      <header className="queued-draft-header">
        <button
          className="queued-draft-toggle"
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded(!expanded)}
        >
          <UiIcon name="queue" size={16} />
          <span>Up next</span>
          <span className="queued-draft-count">{queue.length}</span>
          <UiIcon name={expanded ? 'up' : 'down'} size={16} />
        </button>
        <button
          className="queued-draft-icon"
          type="button"
          aria-label={paused ? 'Resume queue' : 'Pause queue'}
          title={paused ? 'Resume queue' : 'Pause queue'}
          disabled={busy}
          onClick={onPause}
        >
          <UiIcon name={paused ? 'play' : 'pause'} size={16} />
        </button>
      </header>
      <MotionPresence open={expanded} kind="disclosure" appear={false}>
        <div id={id}>
          <p className="queued-draft-caption">
            {paused
              ? 'Paused. Your drafts stay here.'
              : 'Drafts · sent one at a time after each response.'}
          </p>
          <ol className="queued-draft-list">
            {queue.map((message, index) => (
              <li key={message.queueEntryId ?? index} className="queued-draft-row">
                <span className="queued-draft-index">{index + 1}</span>
                <div className="queued-draft-copy">
                  <span>{message.text}</span>
                  {message.replyTo && (
                    <small>
                      Reply to {message.replyTo.role === 'user' ? 'you' : 'Mitzo'}:{' '}
                      {message.replyTo.text}
                    </small>
                  )}
                  {message.images.length > 0 && (
                    <small>
                      {message.images.length} attachment{message.images.length === 1 ? '' : 's'}
                    </small>
                  )}
                  <small>
                    {message.requiresRetry
                      ? message.dispatchPending
                        ? 'Delivery unconfirmed. Check or retry the same message.'
                        : 'Review before sending again'
                      : index === 0
                        ? paused
                          ? 'Paused'
                          : 'Next in line'
                        : ''}
                  </small>
                </div>
                <div className="queued-draft-actions">
                  <button
                    className="queued-draft-icon"
                    type="button"
                    aria-label={
                      message.dispatchPending
                        ? `Check delivery of queued prompt ${index + 1}`
                        : `${running ? 'Steer with' : 'Send'} queued prompt ${index + 1}`
                    }
                    title={
                      message.dispatchPending
                        ? 'Check delivery using this message’s saved identity.'
                        : running && textOnlySteer && message.images.length
                          ? 'Steering accepts text only. Wait to send these attachments.'
                          : running
                            ? 'Send this correction to the current turn'
                            : 'Send this prompt now'
                    }
                    disabled={
                      (message.dispatchPending ? recoveryBlocked : blocked) ||
                      busy ||
                      (!message.dispatchPending &&
                        running &&
                        textOnlySteer &&
                        message.images.length > 0)
                    }
                    onClick={() => onSend(index)}
                  >
                    <UiIcon
                      name={message.dispatchPending ? 'retry' : running ? 'interrupt' : 'send'}
                      size={16}
                    />
                  </button>
                  <button
                    className="queued-draft-icon"
                    type="button"
                    aria-label={`Edit, reorder or remove queued prompt ${index + 1}`}
                    title="Edit, reorder or remove"
                    disabled={busy || !!message.dispatchPending}
                    onClick={() => {
                      setEditor({
                        id: message.queueEntryId,
                        index,
                        message,
                        text: message.text,
                        position: index,
                      });
                      setError('');
                    }}
                  >
                    <UiIcon name="more" size={16} />
                  </button>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </MotionPresence>
      <HomeDialog
        title="Queued prompt"
        onClose={close}
        open={!!editor}
        className="queued-draft-editor"
      >
        <label>
          Prompt
          <textarea
            value={editor?.text ?? ''}
            onChange={(event) =>
              setEditor((current) => (current ? { ...current, text: event.target.value } : null))
            }
          />
        </label>
        {editor?.message.images.length ? (
          <div className="chat-input-previews">
            {editor.message.images.map((image, index) => (
              <img
                key={index}
                src={image.preview}
                alt={`Queued attachment ${index + 1}`}
                width={64}
                height={64}
              />
            ))}
          </div>
        ) : null}
        {editor?.message.contextBlocks.length ? (
          <p>Context: {editor.message.contextBlocks.join(', ')}</p>
        ) : null}
        <p>Your composer draft stays separate.</p>
        <div className="queued-draft-position">
          <span>
            Position {(editor?.position ?? 0) + 1} of {queue.length}
          </span>
          <button
            type="button"
            className="queued-draft-icon"
            aria-label="Move prompt earlier"
            disabled={!editor || editor.position <= 0}
            onClick={() =>
              setEditor((current) =>
                current ? { ...current, position: current.position - 1 } : null,
              )
            }
          >
            <UiIcon name="up" size={16} />
          </button>
          <button
            type="button"
            className="queued-draft-icon"
            aria-label="Move prompt later"
            disabled={!editor || editor.position >= queue.length - 1}
            onClick={() =>
              setEditor((current) =>
                current ? { ...current, position: current.position + 1 } : null,
              )
            }
          >
            <UiIcon name="down" size={16} />
          </button>
        </div>
        {error && <p role="alert">{error}</p>}
        <footer>
          <button
            type="button"
            className="home-secondary"
            onClick={() => {
              if (editIndex >= 0) onRemove(editIndex);
              close();
            }}
          >
            Remove
          </button>
          <button type="button" className="home-secondary" onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className="home-primary"
            onClick={async () => {
              if (!editor || !editor.text.trim() || editIndex < 0) {
                setError('Keep this prompt open and enter a message before saving.');
                return;
              }
              if (
                !onUpdate(
                  editIndex,
                  { ...editor.message, text: editor.text.trim() },
                  editor.position,
                )
              ) {
                setError('Could not save this queued prompt. Your edits are kept.');
                return;
              }
              const submittedEditor = editor;
              try {
                await chatStorage.flush();
                if (chatStorage.failed) throw Error('storage');
                if (activeEditor.current === submittedEditor) close();
              } catch {
                if (activeEditor.current === submittedEditor)
                  setError('Could not save this queued prompt. Your edits are kept.');
              }
            }}
          >
            Save changes
          </button>
        </footer>
      </HomeDialog>
    </section>
  );
}
