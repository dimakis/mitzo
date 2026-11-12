import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { QueuedMessage } from '../hooks/useQueuedMessages';
import { chatStorage } from '../lib/large-chat-storage';
import { MotionPresence } from './MotionPresence';
import { UiIcon } from './UiIcon';
import './QueuedDraftTray.css';

type Props = {
  queue: QueuedMessage[];
  paused: boolean;
  busy: boolean;
  running: boolean;
  blocked: boolean;
  blockedReason?: string;
  recoveryBlocked?: boolean;
  nativeSteer: boolean;
  onPause(): void;
  onSend(index: number): void;
  onUpdate(index: number, message: QueuedMessage, position: number): boolean;
  onRemove(index: number): void;
  onEditingChange(open: boolean): void;
};
type Editor = {
  id?: string;
  index: number;
  message: QueuedMessage;
  text: string;
  position: number;
};

export function QueuedDraftTray({
  queue,
  paused,
  busy,
  running,
  blocked,
  blockedReason,
  recoveryBlocked = blocked,
  nativeSteer,
  onPause,
  onSend,
  onUpdate,
  onRemove,
  onEditingChange,
}: Props) {
  const [expanded, setExpanded] = useState(true);
  const [reordering, setReordering] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [error, setError] = useState('');
  const [moving, setMoving] = useState(false);
  const [orderError, setOrderError] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const activeEditor = useRef(editor);
  activeEditor.current = editor;
  const alive = useRef(true);
  const operation = useRef(false);
  const buttons = useRef(new Map<string | number, HTMLButtonElement>());
  const pendingFocus = useRef<string | number | undefined>(undefined);
  const id = useId();
  const editing = !!editor || moving || orderError;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    onEditingChange(editing);
    return () => onEditingChange(false);
  }, [editing, onEditingChange]);
  const editIndex = editor
    ? queue.findIndex((item, index) =>
        editor.id ? item.queueEntryId === editor.id : index === editor.index,
      )
    : -1;
  const disabled = busy || moving || orderError;
  useLayoutEffect(() => {
    if (pendingFocus.current === undefined || disabled) return;
    const button = buttons.current.get(pendingFocus.current);
    if (button) {
      button.focus({ preventScroll: true });
      button.scrollIntoView?.({ block: 'nearest' });
      pendingFocus.current = undefined;
    }
  });
  const focus = (message: QueuedMessage, index: number) =>
    buttons.current.get(message.queueEntryId ?? index)?.focus();
  const close = () => {
    const previous = editor;
    setEditor(null);
    setError('');
    if (previous) focus(previous.message, editIndex);
  };
  const canMove = (index: number, target: number) =>
    !disabled &&
    index >= 0 &&
    target >= 0 &&
    target < queue.length &&
    queue
      .slice(Math.min(index, target), Math.max(index, target) + 1)
      .every((item) => !item.dispatchPending);

  const move = async (index: number, target: number) => {
    if (!canMove(index, target) || operation.current || index === target) return;
    const message = queue[index];
    operation.current = true;
    onEditingChange(true);
    setMoving(true);
    setError('');
    try {
      if (!onUpdate(index, message, target)) {
        setError('Could not change dispatch order. Check the current queue and try again.');
        return;
      }
      await chatStorage.flush();
      if (chatStorage.failed) throw Error('storage');
      if (alive.current) {
        setEditor(null);
        setAnnouncement(
          'Dispatch order changed. Position ' +
            (target + 1) +
            ' of ' +
            queue.length +
            '. Nothing was sent.',
        );
        pendingFocus.current = message.queueEntryId ?? target;
      }
    } catch (cause) {
      console.warn('Queued draft persistence failed', {
        code: 'queued_draft_persistence_failed',
        stage: 'save_order',
        entryId: message.queueEntryId,
        cause: cause instanceof Error ? cause.name : 'Unknown',
      });
      if (alive.current) {
        setOrderError(true);
        setError(
          'Could not save dispatch order. Automatic dispatch is held until saving succeeds.',
        );
      }
    } finally {
      operation.current = false;
      if (alive.current) setMoving(false);
    }
  };
  const retryOrder = async () => {
    if (operation.current) return;
    operation.current = true;
    setMoving(true);
    try {
      await chatStorage.flush();
      if (chatStorage.failed) throw Error('storage');
      if (alive.current) {
        setOrderError(false);
        setError('');
        setAnnouncement('Dispatch order saved.');
      }
    } catch (cause) {
      console.warn('Queued draft persistence failed', {
        code: 'queued_draft_persistence_failed',
        stage: 'retry_order',
        cause: cause instanceof Error ? cause.name : 'Unknown',
      });
      if (alive.current)
        setError(
          'Could not save dispatch order. Automatic dispatch is held until saving succeeds.',
        );
    } finally {
      operation.current = false;
      if (alive.current) setMoving(false);
    }
  };
  const saveEditor = async () => {
    if (!editor || !editor.text.trim() || editIndex < 0) {
      setError('Keep this prompt open and enter a message before saving.');
      return;
    }
    if (!onUpdate(editIndex, { ...editor.message, text: editor.text.trim() }, editor.position)) {
      setError('Could not save this queued prompt. Your edits are kept.');
      return;
    }
    const submittedEditor = editor;
    try {
      await chatStorage.flush();
      if (chatStorage.failed) throw Error('storage');
      if (activeEditor.current === submittedEditor && alive.current) close();
    } catch (cause) {
      console.warn('Queued draft persistence failed', {
        code: 'queued_draft_persistence_failed',
        stage: 'save_prompt',
        entryId: submittedEditor.id,
        cause: cause instanceof Error ? cause.name : 'Unknown',
      });
      if (activeEditor.current === submittedEditor && alive.current)
        setError('Could not save this queued prompt. Your edits are kept.');
    }
  };
  if (!queue.length && !editor && !orderError) return null;
  return (
    <section role="region" className="queued-draft-tray" aria-label="Up next">
      <header className="queued-draft-header">
        <button
          className="queued-draft-toggle"
          type="button"
          aria-label={expanded ? 'Minimize queue' : 'Expand queue'}
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded(!expanded)}
        >
          <UiIcon name="queue" size={16} />
          <span>Up next</span>
          <span className="queued-draft-count">{queue.length}</span>
          {!expanded && (
            <span className="queued-draft-summary">
              {paused ? 'Paused · ' : 'Next · '}
              {queue[0]?.text}
            </span>
          )}
          <UiIcon name={expanded ? 'up' : 'down'} size={16} />
        </button>
        <button
          type="button"
          className="queued-draft-reorder"
          aria-label={reordering ? 'Done reordering' : 'Reorder dispatch order'}
          aria-pressed={reordering}
          disabled={disabled || !!editor || queue.length < 2}
          onClick={() => {
            setExpanded(true);
            setReordering(!reordering);
          }}
        >
          {reordering ? 'Done' : 'Reorder'}
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
          <ol
            className={'queued-draft-list' + (editor ? ' queued-draft-list--editing' : '')}
            aria-label="Messages in dispatch order"
          >
            {queue.map((message, index) => {
              const selected = editor && index === editIndex;
              const contextReason =
                running && nativeSteer && message.contextBlocks.length
                  ? 'Queue context changes as a new message. Corrections keep the active turn’s context.'
                  : undefined;
              const state = message.requiresRetry
                ? message.dispatchPending
                  ? 'Delivery unconfirmed'
                  : 'Review before sending again'
                : paused
                  ? 'Paused'
                  : index === 0
                    ? 'Next in line'
                    : 'After ' + index;
              return (
                <li key={message.queueEntryId ?? index} className="queued-draft-row">
                  <span className="queued-draft-index">{index + 1}</span>
                  <button
                    type="button"
                    className="queued-draft-copy"
                    ref={(button) => {
                      const key = message.queueEntryId ?? index;
                      if (button) buttons.current.set(key, button);
                      else buttons.current.delete(key);
                    }}
                    aria-label={'Edit, reorder or remove queued prompt ' + (index + 1)}
                    aria-expanded={!!selected}
                    title={message.text}
                    aria-describedby={id + '-preview-' + index}
                    disabled={disabled || !!message.dispatchPending}
                    onClick={() => {
                      if (selected) {
                        close();
                        return;
                      }
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
                    <span id={id + '-preview-' + index}>{message.text}</span>
                    <small>
                      {state}
                      {message.images.length > 0 &&
                        ' · ' +
                          message.images.length +
                          ' attachment' +
                          (message.images.length > 1 ? 's' : '')}
                      {message.replyTo && ' · Reply'}
                      {message.contextBlocks.length > 0 && ' · Context'}
                    </small>
                  </button>
                  <div className="queued-draft-actions">
                    {reordering ? (
                      [-1, 1].map((delta) => (
                        <button
                          key={delta}
                          className="queued-draft-icon"
                          type="button"
                          aria-label={
                            'Move queued prompt ' +
                            (index + 1) +
                            (delta < 0 ? ' earlier' : ' later')
                          }
                          disabled={!canMove(index, index + delta) || !!editor}
                          onClick={() => void move(index, index + delta)}
                        >
                          <UiIcon name={delta < 0 ? 'up' : 'down'} size={16} />
                        </button>
                      ))
                    ) : (
                      <button
                        className="queued-draft-icon queued-draft-send"
                        type="button"
                        aria-label={
                          message.dispatchPending
                            ? 'Check delivery of queued prompt ' + (index + 1)
                            : (running ? 'Steer with' : 'Send') + ' queued prompt ' + (index + 1)
                        }
                        title={
                          message.dispatchPending
                            ? 'Check delivery using this message’s saved identity.'
                            : (blockedReason ??
                              contextReason ??
                              (running
                                ? 'Send this correction to the current turn'
                                : 'Send this prompt now'))
                        }
                        disabled={
                          (message.dispatchPending ? recoveryBlocked : blocked) ||
                          disabled ||
                          !!contextReason ||
                          !!editor
                        }
                        onClick={() => onSend(index)}
                      >
                        <UiIcon
                          name={message.dispatchPending ? 'retry' : running ? 'interrupt' : 'send'}
                          size={16}
                        />
                      </button>
                    )}
                  </div>
                  <MotionPresence
                    open={!!selected}
                    kind="disclosure"
                    appear={false}
                    className="queued-draft-detail"
                  >
                    <section
                      className="queued-draft-editor"
                      aria-label="Queued prompt"
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          event.preventDefault();
                          close();
                        }
                      }}
                    >
                      <label>
                        Prompt
                        <textarea
                          value={selected ? editor.text : ''}
                          onChange={(event) =>
                            setEditor((current) =>
                              current ? { ...current, text: event.target.value } : null,
                            )
                          }
                        />
                      </label>
                      {message.replyTo && (
                        <p>
                          Reply to {message.replyTo.role === 'user' ? 'you' : 'Mitzo'}:{' '}
                          {message.replyTo.text}
                        </p>
                      )}
                      {message.images.length > 0 && (
                        <div className="chat-input-previews">
                          {message.images.map((image, imageIndex) => (
                            <img
                              key={imageIndex}
                              src={image.preview}
                              alt={'Queued attachment ' + (imageIndex + 1)}
                              width={64}
                              height={64}
                            />
                          ))}
                        </div>
                      )}
                      {message.contextBlocks.length > 0 && (
                        <p>Context: {message.contextBlocks.join(', ')}</p>
                      )}
                      {contextReason && <p>{contextReason}</p>}
                      <p>
                        Position {(selected ? editor.position : index) + 1} of {queue.length} ·{' '}
                        {state}. Sent one at a time after each response. Your composer draft stays
                        separate.
                      </p>
                      <div className="queued-draft-position">
                        <button
                          type="button"
                          className="queued-draft-icon"
                          aria-label="Move prompt earlier"
                          disabled={!selected || !canMove(index, editor.position - 1)}
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
                          disabled={!selected || !canMove(index, editor.position + 1)}
                          onClick={() =>
                            setEditor((current) =>
                              current ? { ...current, position: current.position + 1 } : null,
                            )
                          }
                        >
                          <UiIcon name="down" size={16} />
                        </button>
                        <button
                          type="button"
                          disabled={index === 0 || !canMove(index, 0)}
                          onClick={() => void move(index, 0)}
                        >
                          Make next
                        </button>
                      </div>
                      <footer>
                        <button
                          type="button"
                          className="queued-draft-remove"
                          disabled={disabled}
                          onClick={() => {
                            onRemove(index);
                            close();
                          }}
                        >
                          Remove
                        </button>
                        <button type="button" onClick={close}>
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="queued-draft-save"
                          disabled={disabled}
                          onClick={() => void saveEditor()}
                        >
                          Save changes
                        </button>
                      </footer>
                    </section>
                  </MotionPresence>
                </li>
              );
            })}
          </ol>
        </div>
      </MotionPresence>
      {blocked && (
        <p className="queued-draft-notice">
          {blockedReason ??
            'Steering is unavailable for this engine or runtime. Your queued drafts are kept.'}
        </p>
      )}
      {moving && (
        <p className="queued-draft-notice" role="status">
          Saving dispatch order…
        </p>
      )}
      {busy && (
        <p className="queued-draft-notice" role="status">
          Queue operation in progress. Your drafts are kept.
        </p>
      )}
      {error && (
        <p className="queued-draft-error" role="alert">
          {error}
        </p>
      )}
      {orderError && (
        <button type="button" disabled={moving} onClick={() => void retryOrder()}>
          Retry saving order
        </button>
      )}
      <span className="queued-draft-announcement" role="status" aria-live="polite">
        {announcement}
      </span>
    </section>
  );
}
