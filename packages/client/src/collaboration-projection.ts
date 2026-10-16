import {
  CollaborationViewSchema,
  CollaborationEventsSchema,
  type CollaborationView,
} from '@mitzo/protocol';

export interface CollaborationProjection {
  view: CollaborationView;
  needsRefresh: boolean;
  eventIds: Record<number, string>;
}
export function createCollaborationProjection(raw: unknown): CollaborationProjection {
  return { view: CollaborationViewSchema.parse(raw), needsRefresh: false, eventIds: {} };
}
/** Metadata projection only. Never reduce collaboration events into ordinary send/queue actions. */
export function applyCollaborationEvents(
  state: CollaborationProjection,
  raw: unknown,
): CollaborationProjection {
  if (state.needsRefresh) return state;
  const parsed = CollaborationEventsSchema.safeParse(raw);
  const refuse = () => ({ ...state, needsRefresh: true });
  if (!parsed.success) return refuse();
  const page = parsed.data;
  const next = structuredClone(state),
    view = next.view;
  for (const event of page.events) {
    if (event.collaborationId !== view.collaborationId) return refuse();
    if (event.sequence <= view.cursor) {
      if (next.eventIds[event.sequence] && next.eventIds[event.sequence] !== event.eventId)
        return refuse();
      continue;
    }
    if (event.sequence !== view.cursor + 1) return refuse();
    const change = event.change;
    switch (change.kind) {
      case 'membership':
        if (change.membership.revision !== view.membershipRevision + 1) return refuse();
        view.membershipRevision = change.membership.revision;
        view.participantSessionIds = change.membership.participantSessionIds;
        view.unavailableParticipantSessionIds = view.unavailableParticipantSessionIds.filter((id) =>
          view.participantSessionIds.includes(id),
        );
        view.policies = change.policies;
        view.policySequence = event.sequence;
        break;
      case 'policy': {
        const current = view.policies.find((p) => p.sessionId === change.policy.sessionId);
        if (!current || change.policy.revision !== current.revision + 1) return refuse();
        view.policies = view.policies.map((p) =>
          p.sessionId === change.policy.sessionId ? change.policy : p,
        );
        view.policySequence = event.sequence;
        break;
      }
      case 'message':
        if (
          change.message.sequence !== event.sequence ||
          view.messages.some(
            (m) =>
              m.messageId === change.message.messageId ||
              m.projectionId === change.message.projectionId,
          )
        )
          return refuse();
        view.messages.push(change.message);
        if (view.messages.length > 50) {
          view.messages.shift();
          view.hasEarlierMessages = true;
        }
        break;
      case 'delivery': {
        const message = view.messages.find((m) => m.messageId === change.messageId);
        const current = message?.deliveries.find(
          (d) => d.deliveryId === change.delivery.deliveryId,
        );
        if (
          !message ||
          !current ||
          change.delivery.revision !== current.revision + 1 ||
          current.sessionId !== change.delivery.sessionId ||
          current.purpose !== change.delivery.purpose
        )
          return refuse();
        message.deliveries = message.deliveries.map((d) =>
          d.deliveryId === current.deliveryId ? change.delivery : d,
        );
        break;
      }
      case 'join':
        view.joins = view.joins.filter((j) => j.joinId !== change.join.joinId);
        if (change.join.state !== 'linked') view.joins.push(change.join);
        view.joins.sort((a, b) => (a.joinId < b.joinId ? -1 : a.joinId > b.joinId ? 1 : 0));
        break;
      case 'snapshot':
        break; // Content is fetched explicitly for review, never auto-delivered.
    }
    view.cursor = event.sequence;
    next.eventIds[event.sequence] = event.eventId;
  }
  if (
    page.cursor !== (page.events.at(-1)?.sequence ?? view.cursor) ||
    page.highWatermark < page.cursor ||
    (!page.hasMore && page.highWatermark !== page.cursor)
  )
    return refuse();
  // Bound duplicate evidence; older pages are already behind the applied cursor.
  for (const key of Object.keys(next.eventIds))
    if (Number(key) < view.cursor - 100) delete next.eventIds[Number(key)];
  return next;
}
