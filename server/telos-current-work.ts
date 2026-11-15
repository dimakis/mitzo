import type { TelosWorkActor } from './telos-work-store.js';

/** Structural port for the canonical team owner's readTeam result. Membership
 * is deliberately separate from formal assignments and ordinary authority. */
export interface CurrentWorkTeam {
  itemId: string;
  revision: string;
  members: Array<{
    membershipId: string;
    conversationId: string;
    displayName: string;
    role: string;
    responsibility: string | null;
    state: 'current' | 'former';
    linkedAt: string | null;
    endedAt: string | null;
    linkedBy: string | null;
    endedBy: string | null;
    operationId: string;
    replacedByMembershipId: string | null;
    reportsToMembershipId: string | null;
  }>;
}

interface ReadOptions {
  state?: 'current' | 'former';
  offset?: number;
  expectedTeamRevision?: string;
}

/** Read-only adapter for an already-authorized canonical team owner. No brief,
 * historical note, transcript, session startup, assignment or message is read.
 * Wiring into the compact overview remains with that tool's sole integrator. */
export function readTelosCurrentWork(
  owner: { readTeam(itemId: string, actor: TelosWorkActor): CurrentWorkTeam },
  itemId: string,
  actor: TelosWorkActor,
  options: ReadOptions = {},
) {
  const offset = options.offset ?? 0;
  const state = options.state ?? 'current';
  if (!Number.isSafeInteger(offset) || offset < 0) throw Error('Invalid team read offset');
  if (state !== 'current' && state !== 'former') throw Error('Invalid team read state');
  if (offset && !options.expectedTeamRevision)
    throw Error('A canonical team revision is required for the next page');
  const team = owner.readTeam(itemId, actor);
  if (team.itemId !== itemId) throw Error('Canonical team item does not match requested item');
  if (options.expectedTeamRevision && options.expectedTeamRevision !== team.revision)
    throw Error('Canonical team changed; restart the compact read');
  const members = team.members.filter((member) => member.state === state);
  if (offset && offset >= members.length) throw Error('Invalid team read offset');
  const truncatedFields: string[] = [];
  const text = (field: string, source: string, limit: number) => {
    if (source.length <= limit) return source;
    truncatedFields.push(field);
    return source.slice(0, limit).replace(/[\uD800-\uDBFF]$/u, '') + '…';
  };
  const participant = (member: CurrentWorkTeam['members'][number], index: number) => {
    const field = `participants[${index}]`;
    const target = team.members.find(
      (entry) => entry.membershipId === member.reportsToMembershipId,
    );
    // A former member and a dangling/former reporting link are never promoted
    // to current routing by following replacement provenance or old receipts.
    const reportingTo =
      member.state === 'former' || !member.reportsToMembershipId
        ? { state: 'not_recorded' as const, membershipId: null, conversationId: null }
        : !target
          ? {
              state: 'unknown' as const,
              membershipId: member.reportsToMembershipId,
              conversationId: null,
            }
          : target.state === 'former'
            ? { state: 'former' as const, membershipId: target.membershipId, conversationId: null }
            : {
                state: 'current' as const,
                membershipId: target.membershipId,
                conversationId: target.conversationId,
                displayName: text(field + '.reportingTo.displayName', target.displayName, 160),
              };
    return {
      membershipId: member.membershipId,
      conversationId: member.conversationId,
      displayName: text(field + '.displayName', member.displayName, 160),
      role: text(field + '.role', member.role, 80),
      responsibility:
        member.responsibility === null
          ? null
          : text(field + '.responsibility', member.responsibility, 240),
      state: member.state,
      linkedAt: member.linkedAt,
      endedAt: member.endedAt,
      operationId: member.operationId,
      replacedByMembershipId: member.replacedByMembershipId,
      reportingTo,
    };
  };
  const page = members.slice(offset, offset + 10);
  const unknown = () => ({
    state: 'unknown' as const,
    reason: 'coordination_source_not_connected' as const,
  });
  return {
    itemId,
    teamRevision: team.revision,
    observedAt: new Date().toISOString(),
    state,
    counts: {
      current: team.members.filter((member) => member.state === 'current').length,
      former: team.members.filter((member) => member.state === 'former').length,
    },
    participants: page.map(participant),
    offset,
    nextOffset: offset + page.length < members.length ? offset + page.length : null,
    truncatedFields,
    // No canonical source for these facts is connected yet. Empty arrays would
    // incorrectly claim there are no dependencies, blockers or pending reviews.
    coordination: {
      dependencies: unknown(),
      blockers: unknown(),
      nextAction: unknown(),
      prReviewEvidence: unknown(),
    },
  };
}
