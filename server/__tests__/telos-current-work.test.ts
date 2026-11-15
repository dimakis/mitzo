import { expect, it, vi } from 'vitest';
import { readTelosCurrentWork, type CurrentWorkTeam } from '../telos-current-work.js';

const actor = { kind: 'operator' as const, id: 'offline-operator' };
const member = (
  id: string,
  state: 'current' | 'former' = 'current',
): CurrentWorkTeam['members'][number] => ({
  membershipId: id,
  conversationId: `chat-${id}`,
  displayName: `Participant ${id}`,
  role: 'contributor',
  responsibility: 'Investigate current work',
  state,
  linkedAt: '2026-11-14T10:00:00Z',
  endedAt: state === 'former' ? '2026-11-14T11:00:00Z' : null,
  linkedBy: 'offline-operator',
  endedBy: state === 'former' ? 'offline-operator' : null,
  operationId: `operation-${id}`,
  replacedByMembershipId: null,
  reportsToMembershipId: null,
});
function fixture(members: CurrentWorkTeam['members'] = [member('worker')]) {
  let team: CurrentWorkTeam = { itemId: 'feature', revision: 'a'.repeat(64), members };
  const readTeam = vi.fn(() => structuredClone(team));
  return {
    readTeam,
    read: (options = {}) => readTelosCurrentWork({ readTeam }, 'feature', actor, options),
    commit(next: CurrentWorkTeam) {
      team = next;
    },
  };
}

it('reads only the authorized explicit roster, with named current responsibility and unknown coordination evidence', () => {
  const f = fixture();
  const view = f.read();
  expect(f.readTeam).toHaveBeenCalledExactlyOnceWith('feature', actor);
  expect(view).toMatchObject({
    itemId: 'feature',
    teamRevision: 'a'.repeat(64),
    participants: [{ membershipId: 'worker', displayName: 'Participant worker', state: 'current' }],
    counts: { current: 1, former: 0 },
    coordination: {
      dependencies: { state: 'unknown' },
      blockers: { state: 'unknown' },
      nextAction: { state: 'unknown' },
      prReviewEvidence: { state: 'unknown' },
    },
  });
  expect(view.observedAt).toEqual(expect.any(String));
  expect(JSON.stringify(view)).not.toContain('assignment');
});

it('refreshes reporting after replacement while preserving old operation identity and refusing a former target', () => {
  const old = { ...member('old-lead'), role: 'orchestrator' };
  const worker = { ...member('worker'), reportsToMembershipId: old.membershipId };
  const f = fixture([old, worker]);
  expect(f.read().participants[1].reportingTo).toMatchObject({
    state: 'current',
    conversationId: 'chat-old-lead',
    membershipId: 'old-lead',
  });
  const former = {
    ...old,
    state: 'former' as const,
    endedAt: '2026-11-14T11:00:00Z',
    replacedByMembershipId: 'new-lead',
  };
  f.commit({
    itemId: 'feature',
    revision: 'b'.repeat(64),
    members: [former, member('new-lead'), worker],
  });
  const next = f.read();
  expect(next.teamRevision).toBe('b'.repeat(64));
  expect(next.participants.find((p) => p.membershipId === 'worker')?.reportingTo).toEqual({
    state: 'former',
    membershipId: 'old-lead',
    conversationId: null,
  });
  const history = f.read({ state: 'former' });
  expect(history.participants[0]).toMatchObject({
    operationId: 'operation-old-lead',
    replacedByMembershipId: 'new-lead',
    reportingTo: { state: 'not_recorded' },
  });
  expect(next.counts).toEqual({ current: 2, former: 1 });
});

it('pages against the canonical revision and bounds text without returning private or historical note bodies', () => {
  const members = Array.from({ length: 24 }, (_, i) => member(String(i)));
  members[0].displayName = '🙂'.repeat(200);
  Object.assign(members[0], { privateNote: 'DO NOT PROJECT', transcript: 'DO NOT PROJECT' });
  const f = fixture(members);
  const first = f.read();
  expect(first.participants).toHaveLength(10);
  expect(first.truncatedFields).toContain('participants[0].displayName');
  expect(first.nextOffset).toBe(10);
  expect(JSON.stringify(first)).not.toContain('DO NOT PROJECT');
  expect(() => f.read({ offset: 10 })).toThrow(/revision/i);
  expect(
    f.read({ offset: 10, expectedTeamRevision: first.teamRevision }).participants,
  ).toHaveLength(10);
  f.commit({ itemId: 'feature', revision: 'b'.repeat(64), members });
  expect(() => f.read({ offset: 10, expectedTeamRevision: first.teamRevision })).toThrow(
    /changed/i,
  );
});

it('preserves an owner failure instead of manufacturing an empty successful team', () => {
  const cause = Error('canonical team unavailable');
  expect(() =>
    readTelosCurrentWork(
      {
        readTeam() {
          throw cause;
        },
      },
      'feature',
      actor,
    ),
  ).toThrow(cause);
  expect(() =>
    readTelosCurrentWork(
      { readTeam: () => ({ itemId: 'other', revision: 'a'.repeat(64), members: [] }) },
      'feature',
      actor,
    ),
  ).toThrow(/item/i);
});
