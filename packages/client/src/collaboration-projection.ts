import {
  CollaborationViewSchema,
  CollaborationEventsSchema,
  type CollaborationView,
  type CollaborationMessage,
} from '@mitzo/protocol';
import type { CollaborationApiClient } from './collaboration-api.js';

export interface CollaborationProjection {
  view: CollaborationView;
  needsRefresh: boolean;
  eventIds: Record<number, string>;
  /** Retained sequence history, independent of the bounded live view. */
  earlierMessages?: CollaborationMessage[];
  historyComplete?: boolean;
}
export function createCollaborationProjection(raw: unknown): CollaborationProjection {
  const view = CollaborationViewSchema.parse(raw);
  return {
    view,
    needsRefresh: false,
    eventIds: {},
    earlierMessages: [],
    historyComplete: !view.hasEarlierMessages,
  };
}

/** Reconstruct exact retained bodies/deliveries through the existing authorized
 * event pages. Reopening starts at zero; subsequent refreshes read only deltas.
 * This never dispatches work or treats a display window as delivery identity. */
export async function refreshCollaborationProjection(
  api: Pick<CollaborationApiClient, 'events'>,
  rawView: CollaborationView,
  starting: CollaborationProjection | null,
  signal?: AbortSignal,
): Promise<CollaborationProjection> {
  const next = createCollaborationProjection(rawView);
  const { view } = next;
  if (!view.hasEarlierMessages) return next;
  if (
    starting &&
    (starting.view.collaborationId !== view.collaborationId || starting.view.cursor > view.cursor)
  )
    throw Error('Conversation history scope or cursor changed. Refresh this conversation.');
  const complete = starting && (starting.historyComplete ?? !starting.view.hasEarlierMessages);
  const messages = new Map<string, CollaborationMessage>(
    (complete
      ? structuredClone([...(starting.earlierMessages ?? []), ...starting.view.messages])
      : []
    ).map((message) => [message.messageId, message]),
  );
  let cursor = complete ? starting.view.cursor : 0;
  const projections = new Set([...messages.values()].map((message) => message.projectionId));
  const fail = () => {
    throw Error('Conversation history identity changed. Refresh this conversation.');
  };
  while (cursor < view.cursor) {
    signal?.throwIfAborted();
    const page = CollaborationEventsSchema.parse(
      await api.events(view.collaborationId, cursor, signal),
    );
    signal?.throwIfAborted();
    if (
      !page.events.length ||
      page.cursor !== page.events.at(-1)!.sequence ||
      page.highWatermark < view.cursor ||
      page.highWatermark < page.cursor ||
      (!page.hasMore && page.highWatermark !== page.cursor) ||
      (page.hasMore && page.highWatermark === page.cursor) ||
      page.events.some(
        (event, index) =>
          event.collaborationId !== view.collaborationId || event.sequence !== cursor + index + 1,
      )
    )
      fail();
    for (const event of page.events) {
      if (event.sequence > view.cursor) break;
      const change = event.change;
      if (change.kind === 'message') {
        if (
          change.message.sequence !== event.sequence ||
          messages.has(change.message.messageId) ||
          projections.has(change.message.projectionId)
        )
          fail();
        messages.set(change.message.messageId, structuredClone(change.message));
        projections.add(change.message.projectionId);
      } else if (change.kind === 'delivery') {
        const message = messages.get(change.messageId);
        const previous = message?.deliveries.find(
          (delivery) => delivery.deliveryId === change.delivery.deliveryId,
        );
        if (
          !message ||
          !previous ||
          previous.sessionId !== change.delivery.sessionId ||
          previous.purpose !== change.delivery.purpose ||
          previous.revision + 1 !== change.delivery.revision
        )
          fail();
        message!.deliveries = message!.deliveries.map((delivery) =>
          delivery.deliveryId === change.delivery.deliveryId ? change.delivery : delivery,
        );
      }
      cursor = event.sequence;
    }
  }
  for (const message of view.messages)
    if (JSON.stringify(messages.get(message.messageId)) !== JSON.stringify(message)) fail();
  const visible = new Set(view.messages.map((message) => message.messageId));
  return {
    ...next,
    historyComplete: true,
    earlierMessages: [...messages.values()]
      .filter((message) => !visible.has(message.messageId))
      .sort((a, b) => a.sequence - b.sequence),
  };
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
        if (
          change.membership.collaborationId !== view.collaborationId ||
          change.membership.revision !== view.membershipRevision + 1 ||
          new Set(change.policies.map((p) => p.sessionId)).size !== change.policies.length ||
          change.policies.some(
            (p) =>
              !change.membership.participantSessionIds.includes(p.sessionId) ||
              p.membershipRevision > change.membership.revision ||
              p.effectiveFromSequence > event.sequence + 1,
          )
        )
          return refuse();
        view.membershipRevision = change.membership.revision;
        if (view.seatOrder)
          view.seatOrder = [
            ...new Set([...view.seatOrder, ...change.membership.participantSessionIds]),
          ];
        view.participantSessionIds = change.membership.participantSessionIds;
        if (view.joinedParticipants)
          view.joinedParticipants = view.joinedParticipants.filter((p) =>
            view.participantSessionIds.includes(p.sessionId),
          );
        view.unavailableParticipantSessionIds = view.unavailableParticipantSessionIds.filter((id) =>
          view.participantSessionIds.includes(id),
        );
        view.policies = change.policies;
        view.policySequence = event.sequence;
        break;
      case 'policy': {
        const current = view.policies.find((p) => p.sessionId === change.policy.sessionId);
        if (
          !current ||
          change.policy.revision !== current.revision + 1 ||
          !view.participantSessionIds.includes(change.policy.sessionId) ||
          change.policy.membershipRevision !== view.membershipRevision ||
          change.policy.effectiveFromSequence !== event.sequence + 1
        )
          return refuse();
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
          ) ||
          (next.earlierMessages ?? []).some(
            (m) =>
              m.messageId === change.message.messageId ||
              m.projectionId === change.message.projectionId,
          )
        )
          return refuse();
        view.messages.push(change.message);
        if (view.messages.length > 50) {
          next.earlierMessages = [...(next.earlierMessages ?? []), view.messages.shift()!];
          view.hasEarlierMessages = true;
        }
        break;
      case 'delivery': {
        const message = [...(next.earlierMessages ?? []), ...view.messages].find(
          (m) => m.messageId === change.messageId,
        );
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
        if (
          change.join.state === 'linked' &&
          change.join.sessionId &&
          view.participantSessionIds.includes(change.join.sessionId)
        ) {
          view.joinedParticipants = [
            ...(view.joinedParticipants ?? []).filter((p) => p.sessionId !== change.join.sessionId),
            { sessionId: change.join.sessionId, name: change.join.name },
          ];
        }
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
    (page.hasMore && page.highWatermark === page.cursor) ||
    (!page.hasMore && page.highWatermark !== page.cursor)
  )
    return refuse();
  // Bound duplicate evidence; older pages are already behind the applied cursor.
  for (const key of Object.keys(next.eventIds))
    if (Number(key) < view.cursor - 100) delete next.eventIds[Number(key)];
  return next;
}
