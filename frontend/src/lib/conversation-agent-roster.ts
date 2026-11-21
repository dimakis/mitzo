import type {
  CollaborationMessage,
  CollaborationSettings,
  CollaborationView,
  SessionActivity,
} from '@mitzo/protocol';
import type { ConversationAgent } from '../components/ConversationAgents';
import { sessionActivityLabel } from './session-activity';

/** Display observations only. Neither membership nor retained settings prove readiness. */
export function projectConversationAgents({
  view,
  names,
  previous = [],
  earlierMessages = [],
  activities = [],
  connected,
}: {
  view: CollaborationView;
  names: Readonly<Record<string, string>>;
  previous?: ConversationAgent[];
  earlierMessages?: CollaborationMessage[];
  activities?: SessionActivity[];
  connected: boolean;
}): ConversationAgent[] {
  const members = new Set(view.participantSessionIds);
  // Activity broadcasts and reordered snapshots must not move a focused seat.
  const order = [...previous.map((a) => a.id).filter((id) => members.has(id))];
  for (const id of members) if (!order.includes(id)) order.push(id);
  const recorded = new Map<string, CollaborationSettings>();
  const joinedAt = new Map<string, number>();
  for (const join of view.joins)
    if (
      join.sessionId &&
      join.state === 'linked' &&
      (joinedAt.get(join.sessionId) ?? -1) <= join.membershipRevision
    ) {
      recorded.set(join.sessionId, join.settings);
      joinedAt.set(join.sessionId, join.membershipRevision);
    }
  for (const message of [...earlierMessages, ...view.messages].sort(
    (a, b) => a.sequence - b.sequence,
  ))
    for (const [id, settings] of Object.entries(message.settings))
      if (message.membershipRevision >= (joinedAt.get(id) ?? 0)) recorded.set(id, settings);
  return order.map((id) => {
    const retained = previous.find((a) => a.id === id);
    const settings = recorded.get(id);
    const activity = activities.find((a) => a.sessionId === id);
    const unavailable = view.unavailableParticipantSessionIds.includes(id);
    const policy = view.policies.find((p) => p.sessionId === id);
    const profile = settings?.selection.agent;
    return {
      id,
      name:
        names[id] ??
        view.joinedParticipants?.find((p) => p.sessionId === id)?.name ??
        retained?.name ??
        'Agent',
      accountId: settings?.binding.account.accountId ?? retained?.accountId,
      account:
        activity?.accountLabel ??
        (settings?.binding.account.accountId &&
        settings.binding.account.accountId !== retained?.accountId
          ? settings.binding.account.accountId
          : (retained?.account ?? settings?.binding.account.accountId)),
      model:
        (activity?.modelUnavailable ? undefined : activity?.model) ??
        settings?.selection.model ??
        retained?.model,
      thinking: settings ? (settings.selection.thinking ?? 'Default') : retained?.thinking,
      profile: profile
        ? `${profile.profileId === 'default-mitzo' ? 'Default Mitzo' : profile.profileId} · revision ${profile.revision}`
        : retained?.profile,
      mode: settings?.selection.permission.mode ?? retained?.mode,
      location: settings
        ? settings.binding.execution.location === 'local'
          ? 'Local Mac'
          : 'OpenShell'
        : retained?.location,
      configurationNote:
        settings || retained?.configurationNote
          ? 'Last recorded configuration; current runtime readiness is checked separately.'
          : undefined,
      membership: unavailable ? 'Member · unavailable' : 'Member',
      state: !connected
        ? 'Not observed'
        : activity
          ? sessionActivityLabel(activity)
          : 'Not observed',
      activityState: connected ? activity?.state : undefined,
      diagnostic: unavailable
        ? 'This member is unavailable. Refresh the conversation to check again.'
        : !connected
          ? 'Activity is disconnected. Refresh the conversation to check current status.'
          : activity?.modelUnavailable
            ? 'The current model could not be verified. Last recorded settings remain visible; refresh to check again.'
            : undefined,
      policy:
        !unavailable && policy
          ? { reads: policy.readsFutureDiscussion, replies: policy.repliesByDefault }
          : undefined,
    };
  });
}
