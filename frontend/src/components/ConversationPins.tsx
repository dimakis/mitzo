import { useId } from 'react';
import type { Session } from '../types/chat';
import { useConversationPins } from '../hooks/useConversationPins';
import { useSessionInteraction, type SessionActionPoint } from '../hooks/useSessionInteraction';
import { MotionPresence } from './MotionPresence';
import { UiIcon } from './UiIcon';
import { formatRelativeTime } from '../lib/formatTime';
import { recordTitle } from '../lib/record-title';
import '../styles/session-library.css';
type Props = {
  sessions: Session[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onPreview?: (session: Session) => void;
  onActions: (session: Session, trigger: HTMLElement, point?: SessionActionPoint) => void;
};
function PinRow({ session, props }: { session: Session; props: Props }) {
  const handlers = useSessionInteraction(
    () => props.onSelect(session.id),
    (trigger, point) => props.onActions(session, trigger, point),
  );
  const title = recordTitle(session.summary || 'Untitled conversation');
  return (
    <div className="conversation-pin-row" data-selected={props.selectedId === session.id}>
      <button
        type="button"
        {...handlers}
        className="conversation-pin-select"
        onFocus={() => props.onPreview?.(session)}
        title={title}
      >
        <span>{title}</span>
        <small>{formatRelativeTime(session.lastModified)}</small>
      </button>
      <button
        type="button"
        className="session-action-trigger"
        aria-label={`Actions for ${title}`}
        onClick={(event) => props.onActions(session, event.currentTarget)}
      >
        <UiIcon name="more" size={16} />
      </button>
    </div>
  );
}
export function ConversationPins(props: Props) {
  const pins = useConversationPins();
  const id = useId();
  const loaded = new Map(props.sessions.map((session) => [session.id, session]));
  if (!pins.pins.length && !pins.error) return null;
  return (
    <section className="conversation-pins" aria-label="Pinned">
      <button
        type="button"
        className="conversation-pins-toggle"
        aria-expanded={!pins.collapsed}
        aria-controls={id}
        aria-label={`${pins.collapsed ? 'Expand' : 'Collapse'} pinned conversations`}
        onClick={() => pins.setCollapsed(!pins.collapsed)}
      >
        <UiIcon name={pins.collapsed ? 'forward' : 'down'} size={16} />
        <UiIcon name="pin" size={16} />
        <span>Pinned</span>
        <span className="conversation-pin-count">{pins.pins.length}</span>
      </button>
      <MotionPresence open={!pins.collapsed} kind="disclosure" appear={false}>
        <div
          id={id}
          role="region"
          aria-label="Pinned conversations"
          className="conversation-pins-scroll"
        >
          {pins.pins.map((pin) => (
            <PinRow key={pin.id} session={loaded.get(pin.id) ?? pin} props={props} />
          ))}
        </div>
      </MotionPresence>
      {pins.error && <p role="alert">{pins.error}</p>}
    </section>
  );
}
