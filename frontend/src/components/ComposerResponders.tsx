import { useEffect, useRef, useState, useId, type RefObject } from 'react';
import type { CollaborationMessageInput } from '@mitzo/protocol';
import { MotionPresence } from './MotionPresence';
import { UiIcon } from './UiIcon';
import './ComposerResponders.css';
import { seatAccentColor } from '../lib/seat-color';
import type { CSSProperties } from 'react';

export interface ComposerResponderSelection {
  members: { id: string; name: string; repliesByDefault?: boolean; unavailableReason?: string }[];
  selectedIds: string[];
  /** Ordinary callers retain this exact protocol intent independently of resolved IDs. */
  responders?: CollaborationMessageInput['responders'];
  onChange(ids: string[], responders?: CollaborationMessageInput['responders']): boolean | void;
  /** Retained adapters may have narrower delivery support than ordinary collaboration. */
  maximum?: number;
  /** Keep the submitting composer mounted until its receipt settles. */
  disabled?: boolean;
  /** Ordinary shared toolbar keeps names in the picker and accessible summary. */
  iconOnly?: boolean;
  /** Shared conversations use direct recipient controls, without a popover. */
  inline?: boolean;
}
type ResponderProps = {
  selection: ComposerResponderSelection;
  text: string;
  onTextChange(text: string): void;
  input: RefObject<HTMLTextAreaElement | null>;
  onOpenChange(open: boolean): void;
};
export function ComposerResponders(props: ResponderProps) {
  return props.selection.inline ? (
    <InlineComposerResponders {...props} />
  ) : (
    <PopoverComposerResponders {...props} />
  );
}
function InlineComposerResponders({ selection, text, onTextChange, input }: ResponderProps) {
  const mention = /(?:^|\s)@([\p{L}\p{N}_-]*)$/u.exec(text);
  const query = mention?.[1].toLowerCase() ?? '';
  const ids =
    selection.responders?.kind === 'all'
      ? selection.members.map((m) => m.id)
      : selection.responders?.kind === 'default'
        ? selection.members.filter((m) => m.repliesByDefault).map((m) => m.id)
        : selection.selectedIds;
  const summary = ids
    .map((id) => selection.members.find((member) => member.id === id)?.name ?? 'Unavailable agent')
    .join(', ');
  const choose = (next: string[]) => {
    if (
      selection.disabled ||
      selection.onChange(next, { kind: 'selected', sessionIds: next }) === false
    )
      return;
    if (mention) onTextChange(text.slice(0, text.lastIndexOf('@')));
    input.current?.focus();
  };
  return (
    <div className="composer-responders-inline" role="group" aria-label="Reply recipients">
      <button
        type="button"
        className="chat-input-btn"
        aria-label="Choose who replies"
        disabled={selection.disabled}
        title={`Replies: ${summary || 'No agents'} · Type @ or select agents inline`}
        data-responder-trigger="inline"
        onClick={() => {
          if (!mention) onTextChange(text + (text && !/\s$/.test(text) ? ' @' : '@'));
          input.current?.focus();
        }}
      >
        @
      </button>
      <div className="composer-responder-names">
        {selection.maximum !== 1 && !query && (
          <button
            type="button"
            className="composer-responder-name"
            disabled={selection.disabled}
            aria-pressed={selection.members.length > 0 && ids.length === selection.members.length}
            onClick={() =>
              choose(selection.members.filter((m) => !m.unavailableReason).map((m) => m.id))
            }
          >
            All
          </button>
        )}
        {selection.members
          .filter((m) => !query || m.name.toLowerCase().includes(query))
          .map((m) => (
            <button
              type="button"
              key={m.id}
              className="composer-responder-name"
              style={{ '--participant-color': seatAccentColor(m.id) } as CSSProperties}
              aria-pressed={ids.includes(m.id)}
              title={m.unavailableReason ?? m.name}
              disabled={selection.disabled || (!!m.unavailableReason && !ids.includes(m.id))}
              onClick={() =>
                choose(
                  ids.includes(m.id)
                    ? ids.filter((id) => id !== m.id)
                    : selection.maximum === 1
                      ? [m.id]
                      : [...ids, m.id],
                )
              }
            >
              {m.name}
            </button>
          ))}
        {ids
          .filter((id) => !selection.members.some((m) => m.id === id))
          .map((id) => (
            <button
              type="button"
              className="composer-responder-name"
              key={id}
              aria-pressed="true"
              disabled={selection.disabled}
              onClick={() => choose(ids.filter((other) => other !== id))}
            >
              Unavailable agent
            </button>
          ))}
      </div>
    </div>
  );
}
function PopoverComposerResponders({
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
  const selectionId = useId();
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
    const retained = selection.onChange(
      ids,
      kind === 'selected' ? { kind, sessionIds: ids } : { kind },
    );
    if (retained === false) return;
    if (mention) onTextChange(text.slice(0, text.lastIndexOf('@')));
    if (selection.maximum === 1) close();
  };
  const matches = selection.members.filter((m) => m.name.toLowerCase().includes(query));
  return (
    <div className="composer-responders" ref={root}>
      <button
        type="button"
        className={`chat-input-btn composer-responders-trigger${selection.iconOnly ? ' composer-responders-trigger--icon' : ''}`}
        ref={trigger}
        aria-label="Choose who replies"
        aria-describedby={selection.iconOnly ? selectionId : undefined}
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
        {selection.iconOnly ? <UiIcon name="agents" /> : <>@{label && <span>{label}</span>}</>}
      </button>
      {selection.iconOnly && (
        <span id={selectionId} className="sr-only">
          {label ? 'Replies: ' + label : 'Choose an agent for this prompt'}
        </span>
      )}
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
                data-responder-choice={query === 'all' ? '' : undefined}
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
                data-responder-choice=""
                checked={selectedIds.includes(m.id)}
                disabled={Boolean(m.unavailableReason) && !selectedIds.includes(m.id)}
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
          <button type="button" onClick={() => close(true)}>
            Done choosing replies
          </button>
        </div>
      </MotionPresence>
    </div>
  );
}
