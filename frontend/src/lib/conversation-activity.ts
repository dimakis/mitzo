import type { SessionActivity } from '@mitzo/protocol';
import { sessionNeedsYouReason } from './session-attention';

function priority(a: SessionActivity) {
  if (sessionNeedsYouReason(a)) return 7;
  return { waiting: 6, working: 5, paused: 4, init: 3, done: 2, idle: 1 }[a.state];
}

/** Read-only navigation projection. Exact participant IDs survive in the raw
 * store and participantActivities; execution/control consumers use that store. */
export function conversationActivities(activities: SessionActivity[]): SessionActivity[] {
  const groups = new Map<string, SessionActivity[]>();
  for (const a of activities) {
    const id = a.presentationConversation?.id ?? a.sessionId;
    const group = groups.get(id) ?? [];
    group.push(a);
    groups.set(id, group);
  }
  return [...groups].map(([id, members]) => {
    if (members.length === 1 && members[0].sessionId === id) return members[0];
    const representative = [...members].sort(
      (a, b) => priority(b) - priority(a) || b.lastEventAt - a.lastEventAt,
    )[0];
    const source = members.find((a) => a.sessionId === id);
    return {
      ...representative,
      sessionId: id,
      clientId: source?.clientId ?? '',
      title:
        members.find((a) => a.presentationConversation)?.presentationConversation!.title ??
        source!.title,
      model: source?.model,
      modelUnavailable: source?.modelUnavailable,
      modelObservedAt: source?.modelObservedAt,
      accountLabel: source?.accountLabel,
      repo: source?.repo,
      taskId: source?.taskId,
      flags: [...new Set(members.flatMap((a) => a.flags))],
      lastEventAt: Math.max(...members.map((a) => a.lastEventAt)),
      lastMessageAt: maxObserved(members.map((a) => a.lastMessageAt)),
      lastUserMessageAt: maxObserved(members.map((a) => a.lastUserMessageAt)),
      awaitingReply: members.some((a) => a.awaitingReply),
      uncommittedWork: members.some((a) => a.uncommittedWork),
      participantActivities: members,
    };
  });
}
function maxObserved(values: Array<number | undefined>) {
  const observed = values.filter((value): value is number => value !== undefined);
  return observed.length ? Math.max(...observed) : undefined;
}
