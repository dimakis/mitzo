import type { EventStore } from '@mitzo/protocol/event-store';
import type { Session } from '@mitzo/protocol';
import { isRegisteredConversation } from '@mitzo/protocol';
import { sessionDisplayName } from './session-naming-context.js';
import { ZERO_TURN_GRACE_MS } from './constants.js';

/** The cached/full Chats adapters share this projection before pagination.
 * This never changes visibility, stored identity, transcripts or execution. */
export function sessionConversationPage(store: EventStore, offset = 0, limit = 20) {
  const now = Date.now();
  const relations = store.collaborationConversation?.navigation() ?? [];
  const sources = new Set(relations.map((r) => r.sourceConversationId));
  const all = store.listSessions().filter((m) => {
    if (m.isHidden || !isRegisteredConversation(m)) return false;
    if (m.conversationSource === 'external_import' || m.symposiumConfig || sources.has(m.sessionId))
      return true;
    if (m.numTurns === 0 && m.promptCount === 0 && !m.isActive)
      return (
        Boolean(m.initialPrompt || m.accountBinding || m.conversationSource === 'mitzo') &&
        now - m.createdAt < ZERO_TURN_GRACE_MS
      );
    return true;
  });
  const metadata = new Map(all.map((m) => [m.sessionId, m]));
  const rows = new Map<string, Session>(
    all.map((m) => [
      m.sessionId,
      {
        id: m.sessionId,
        summary: m.summary ?? '',
        lastModified: m.updatedAt,
        branch: m.branch ?? undefined,
        cwd: m.cwd ?? undefined,
      },
    ]),
  );
  for (const relation of relations) {
    const source = rows.get(relation.sourceConversationId),
      participant = rows.get(relation.sessionId);
    if (!source || !participant) continue;
    source.lastModified = Math.max(source.lastModified, participant.lastModified);
    (source.participantSessionIds ??= []).push(participant.id);
    rows.delete(participant.id);
  }
  const grouped = [...rows.values()].sort((a, b) => b.lastModified - a.lastModified);
  return {
    sessions: grouped
      .slice(offset, offset + limit)
      .map((row) => ({
        ...row,
        summary: sessionDisplayName(metadata.get(row.id)!, () =>
          store.getSessionNamingEvents(row.id),
        ),
      })),
    hasMore: grouped.length > offset + limit,
  };
}
