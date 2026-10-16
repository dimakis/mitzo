import { useEffect, useRef, useState, type RefObject } from 'react';
import { MotionPresence } from './MotionPresence';
import './ComposerResponders.css';

export interface ComposerResponderSelection {
  members: { id: string; name: string }[];
  selectedIds: string[];
  onChange(ids: string[]): void;
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
  const panel = useRef<HTMLDivElement>(null);
  const mention = /(?:^|\s)@([\p{L}\p{N}_-]*)$/u.exec(text);
  const query = mention?.[1].toLowerCase() ?? '';
  const hasMention = mention !== null;
  const activeOpen = open && !selection.disabled;
  useEffect(() => {
    if (selection.disabled) setOpen(false);
    else if (hasMention && dismissed !== text) setOpen(true);
  }, [text, hasMention, dismissed, selection.disabled]);
  useEffect(() => {
    onOpenChange(activeOpen);
    return () => onOpenChange(false);
  }, [activeOpen, onOpenChange]);
  const close = () => {
    setOpen(false);
    setDismissed(text);
    input.current?.focus();
  };
  const choose = (ids: string[]) => {
    if (selection.disabled) return;
    selection.onChange(ids);
    if (mention) onTextChange(text.slice(0, text.lastIndexOf('@')));
    if (selection.maximum === 1) close();
  };
  const matches = selection.members.filter((m) => m.name.toLowerCase().includes(query));
  return (
    <div className="composer-responders">
      <button
        type="button"
        className="chat-input-btn composer-responders-trigger"
        aria-label="Choose who replies"
        aria-expanded={activeOpen}
        disabled={selection.disabled}
        title={
          selection.selectedIds.length
            ? 'Replies: ' +
              selection.members
                .filter((m) => selection.selectedIds.includes(m.id))
                .map((m) => m.name)
                .join(', ')
            : 'Use default replies, or choose agents for this prompt'
        }
        onClick={() => setOpen((v) => !v)}
      >
        @
        {selection.selectedIds.length > 0 && (
          <span>
            {selection.selectedIds
              .map((id) => selection.members.find((m) => m.id === id)?.name ?? 'Unavailable agent')
              .join(', ')}
          </span>
        )}
      </button>
      <MotionPresence open={activeOpen} kind="popover">
        <div
          ref={panel}
          role="group"
          aria-label="Who replies to this prompt"
          className="composer-responder-picker"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              close();
            }
          }}
        >
          <strong>Who replies to this prompt</strong>
          {selection.maximum !== 1 && (
            <button type="button" onClick={() => choose(selection.members.map((m) => m.id))}>
              All agents
            </button>
          )}
          {matches.map((m) => (
            <label key={m.id}>
              <input
                type="checkbox"
                checked={selection.selectedIds.includes(m.id)}
                onChange={(e) =>
                  choose(
                    e.target.checked
                      ? selection.maximum === 1
                        ? [m.id]
                        : [...selection.selectedIds, m.id]
                      : selection.selectedIds.filter((id) => id !== m.id),
                  )
                }
              />
              <span>
                {m.name}
                {selection.members.filter((other) => other.name === m.name).length > 1
                  ? ` · ${m.id.slice(-6)}`
                  : ''}
              </span>
            </label>
          ))}
          {matches.length === 0 && <p>No matching agent.</p>}
          <button type="button" onClick={close}>
            Done choosing replies
          </button>
        </div>
      </MotionPresence>
    </div>
  );
}
