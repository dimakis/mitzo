import { expect, it } from 'vitest';
import {
  CollaborationViewSchema,
  COLLABORATION_EXECUTION_DISABLED,
  type CollaborationEvent,
} from '@mitzo/protocol';
import {
  createCollaborationProjection,
  applyCollaborationEvents,
} from '../collaboration-projection.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const policy = {
  version: 1 as const,
  sessionId: 'reader',
  revision: 0,
  membershipRevision: 1,
  effectiveFromSequence: 0,
  readsFutureDiscussion: true,
  repliesByDefault: false,
};
const initial = () =>
  createCollaborationProjection(
    CollaborationViewSchema.parse({
      version: 1,
      collaborationId: id(1),
      membershipRevision: 1,
      participantSessionIds: ['reader'],
      unavailableParticipantSessionIds: [],
      cursor: 0,
      policySequence: 0,
      policies: [policy],
      messages: [],
      hasEarlierMessages: false,
      joins: [],
      execution: COLLABORATION_EXECUTION_DISABLED,
    }),
  );
const event = (sequence: number, change: CollaborationEvent['change']): CollaborationEvent => ({
  version: 1,
  collaborationId: id(1),
  eventId: id(sequence + 10),
  sequence,
  change,
});
const page = (...events: CollaborationEvent[]) => ({
  events,
  cursor: events.at(-1)!.sequence,
  highWatermark: events.at(-1)!.sequence,
  hasMore: false,
});

it('refuses a nested membership belonging to another conversation before publishing any page changes', () => {
  const state = initial();
  const result = applyCollaborationEvents(
    state,
    page(
      event(1, { kind: 'policy', policy: { ...policy, revision: 1, effectiveFromSequence: 2 } }),
      event(2, {
        kind: 'membership',
        membership: {
          version: 1,
          collaborationId: id(999),
          revision: 2,
          participantSessionIds: ['intruder'],
        },
        policies: [],
      }),
    ),
  );
  expect(result.needsRefresh).toBe(true);
  expect(result.view).toEqual(state.view);
});

it.each([{ membershipRevision: 2 }, { sessionId: 'not-a-member' }, { effectiveFromSequence: 99 }])(
  'refuses policy authority outside the applied membership or event boundary: %j',
  (invalid) => {
    const state = initial();
    const result = applyCollaborationEvents(
      state,
      page(
        event(1, {
          kind: 'policy',
          policy: { ...policy, revision: 1, effectiveFromSequence: 2, ...invalid },
        }),
      ),
    );
    expect(result.needsRefresh).toBe(true);
    expect(result.view).toEqual(state.view);
  },
);

it('refuses membership policy rows for other recipients or another revision', () => {
  for (const invalid of [{ sessionId: 'intruder' }, { membershipRevision: 3 }]) {
    const state = initial();
    const result = applyCollaborationEvents(
      state,
      page(
        event(1, {
          kind: 'membership',
          membership: {
            version: 1,
            collaborationId: id(1),
            revision: 2,
            participantSessionIds: ['reader'],
          },
          policies: [{ ...policy, membershipRevision: 2, ...invalid }],
        }),
      ),
    );
    expect(result.needsRefresh).toBe(true);
    expect(result.view).toEqual(state.view);
  }
});

it('refuses contradictory pagination and freezes replay after refusal without advancing the cursor', () => {
  const state = initial();
  const update = event(1, {
    kind: 'policy',
    policy: { ...policy, revision: 1, effectiveFromSequence: 2 },
  });
  const result = applyCollaborationEvents(state, { ...page(update), hasMore: true });
  expect(result.needsRefresh).toBe(true);
  expect(result.view.cursor).toBe(0);
  expect(applyCollaborationEvents(result, page(update))).toBe(result);
});

it('retains a surviving member policy from an earlier membership revision, as the actual store does', () => {
  const state = initial();
  const result = applyCollaborationEvents(
    state,
    page(
      event(1, {
        kind: 'membership',
        membership: {
          version: 1,
          collaborationId: id(1),
          revision: 2,
          participantSessionIds: ['reader'],
        },
        policies: [policy],
      }),
    ),
  );
  expect(result.needsRefresh).toBe(false);
  expect(result.view.policies).toEqual([policy]);
});
