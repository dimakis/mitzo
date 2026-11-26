import type { Session } from '../types/chat';
import { sharedConversationLabel } from '../lib/shared-conversation-identity';
import './SharedConversationMarker.css';

/** Summary-only list presentation. Opening history retains the row's navigation owner. */
export function SharedConversationMarker({ session }: { session: Session }) {
  const shared = session.sharedConversation;
  if (!shared || shared.sourceConversationId !== session.id) return null;
  const unavailable = shared.unavailableParticipantSessionIds.length;
  return (
    <span className="shared-conversation-marker">
      <span>{sharedConversationLabel(shared.participantSessionIds.length)}</span>
      {unavailable > 0 && <span>{unavailable} unavailable</span>}
    </span>
  );
}
