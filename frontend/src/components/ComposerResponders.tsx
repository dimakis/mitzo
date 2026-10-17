import { useEffect, useRef, useState, useId, type RefObject } from 'react';
import type { CollaborationMessageInput } from '@mitzo/protocol';
import { MotionPresence } from './MotionPresence';
import './ComposerResponders.css';

export interface ComposerResponderSelection {
  members: { id: string; name: string; repliesByDefault?: boolean; unavailableReason?: string }[];
  selectedIds: string[];
  /** Ordinary callers retain this exact protocol intent independently of resolved IDs. */
  responders?: CollaborationMessageInput['responders'];
  onChange(ids: string[], responders?: CollaborationMessageInput['responders']): void;
  /** Retained adapters may have narrower delivery support than ordinary collaboration. */
  maximum?: number;
  /** Keep the submitting composer mounted until its receipt settles. */
  disabled?: boolean;
}
export function ComposerResponders({
  selection,
  text,
  onTextChange,
  input,
  onOpenChange,
}: {
  selection: ComposerResponderSelection;
  text: string;
  onTextChange(text: string): void;
  input: RefObject<HTMLTextAreaElement | null>;
  onOpenChange(open: boolean): void;
}) {
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const openedFromInput = useRef(false);
  const panelId = useId();
  const intent =
    selection.responders ??
    (selection.selectedIds.length
      ? { kind: 'selected' as const, sessionIds: selection.selectedIds }
      : { kind: 'default' as const });
  const selectedIds =
    intent.kind === 'all'
      ? selection.members.map((m) => m.id)
      : intent.kind === 'selected'
        ? intent.sessionIds
        : selection.members.filter((m) => m.repliesByDefault).map((m) => m.id);
  const label =
    intent.kind === 'default'
      ? selection.maximum === 1
        ? ''
        : 'Defaults'
      : intent.kind === 'all'
        ? 'All agents'
        : selectedIds.length
          ? selectedIds
              .map((id) => selection.members.find((m) => m.id === id)?.name ?? 'Unavailable agent')
              .join(', ')
          : 'No agents';
  const mention = /(?:^|\s)@([\p{L}\p{N}_-]*)$/u.exec(text);
  const query = mention?.[1].toLowerCase() ?? '';
  const hasMention = mention !== null;
  const activeOpen = open && !selection.disabled;
  useEffect(() => {
    if (selection.disabled) setOpen(false);
    else if (hasMention && dismissed !== text) {
      openedFromInput.current = true;
      setOpen(true);
    }
  }, [text, hasMention, dismissed, selection.disabled]);
  useEffect(() => {
    onOpenChange(activeOpen);
    return () => onOpenChange(false);
  }, [activeOpen, onOpenChange]);
  useEffect(() => {
    if (!activeOpen) return;
    const dismiss = (event: Event) => {
      if (
        event.target instanceof Node &&
        !root.current?.contains(event.target) &&
        event.target !== input.current
      ) {
        setOpen(false);
        setDismissed(text);
      }
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('focusin', dismiss);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('focusin', dismiss);
    };
  }, [activeOpen, input, text]);
  const close = (restoreTrigger = false) => {
    setOpen(false);
    setDismissed(text);
    (restoreTrigger && !openedFromInput.current ? trigger.current : input.current)?.focus();
  };
  const choose = (ids: string[], kind: 'default' | 'all' | 'selected' = 'selected') => {
    if (selection.disabled) return;
    selection.onChange(ids, kind === 'selected' ? { kind, sessionIds: ids } : { kind });
    if (mention) onTextChange(text.slice(0, text.lastIndexOf('@')));
    if (selection.maximum === 1) close();
  };
  const matches = selection.members.filter((m) => m.name.toLowerCase().includes(query));
  return (
    <div className="composer-responders" ref={root}>
      <button
        type="button"
        className="chat-input-btn composer-responders-trigger"
        ref={trigger}
        aria-label="Choose who replies"
        aria-controls={activeOpen ? panelId : undefined}
        aria-expanded={activeOpen}
        disabled={selection.disabled}
        title={label ? 'Replies: ' + label : 'Choose an agent for this prompt'}
        onClick={(event) => {
          event.currentTarget.focus();
          openedFromInput.current = false;
          setDismissed(text);
          setOpen((v) => !v);
        }}
      >
        @{label && <span>{label}</span>}
      </button>
      <MotionPresence open={activeOpen} kind="popover">
        <div
          id={panelId}
          role="group"
          aria-label="Who replies to this prompt"
          className="composer-responder-picker"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              close(true);
            }
          }}
        >
          <strong>Who replies to this prompt</strong>
          {selection.maximum !== 1 && (
            <>
              <button
                type="button"
                aria-pressed={intent.kind === 'default'}
                onClick={() => choose([], 'default')}
              >
                Defaults
              </button>
              <button
                type="button"
                aria-pressed={intent.kind === 'all'}
                onClick={() =>
                  choose(
                    selection.members.map((m) => m.id),
                    'all',
                  )
                }
              >
                All agents
              </button>
            </>
          )}
          {matches.map((m) => (
            <label key={m.id}>
              <input
                type="checkbox"
                checked={selectedIds.includes(m.id)}
                disabled={Boolean(m.unavailableReason)}
                onChange={(e) =>
                  choose(
                    e.target.checked
                      ? selection.maximum === 1
                        ? [m.id]
                        : [...selectedIds, m.id]
                      : selectedIds.filter((id) => id !== m.id),
                  )
                }
              />
              <span>
                {m.name}
                {selection.members.filter(
                  (other) => other.name.toLowerCase() === m.name.toLowerCase(),
                ).length > 1
                  ? ` · ${m.id.slice(-6)}`
                  : ''}
                {m.unavailableReason && ` · ${m.unavailableReason}`}
              </span>
            </label>
          ))}
          {selectedIds
            .filter((id) => !selection.members.some((m) => m.id === id))
            .map((id) => (
              <label key={id}>
                <input
                  type="checkbox"
                  checked
                  onChange={() => choose(selectedIds.filter((other) => other !== id))}
                />
                <span>Unavailable agent · {id}</span>
              </label>
            ))}
          {matches.length === 0 && <p>No matching agent.</p>}
          <button type="button" onClick={() => close()}>
            Done choosing replies
          </button>
        </div>
      </MotionPresence>
    </div>
  );
}
