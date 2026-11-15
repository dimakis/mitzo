// Copy to server/__tests__/telos-current-work-team.test.mjs in the disposable
// composition of the canonical membership candidate and current-work adapter.
// This is an offline dependency qualification fixture, not a default-suite skip.
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTelosCanonicalData } from '../../server/__tests__/fixtures/telos-canonical-advisor.js';
import { TelosWorkStore } from '../../server/telos-work-store.js';
import { readTelosCurrentWork } from '../../server/telos-current-work.js';

const cleanup = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);

function fixture(variant) {
  const canonical = createTelosCanonicalData(variant);
  cleanup.push(() => canonical.close());
  const available = new Set(['planning', 'next-owner', 'reviewer']);
  const stores = [];
  const open = () => {
    const store = new TelosWorkStore(canonical.dbPath, {
      ordinaryConversation: (id) => available.has(id),
      sourceConversation: (id) => available.has(id) || id === 'shared-discussion',
    });
    stores.push(store);
    return store;
  };
  cleanup.push(() => stores.forEach((store) => store.close()));
  let store = open();
  const actor = canonical.actor;
  const read = (options = {}, selectedActor = actor) =>
    readTelosCurrentWork(store, 'studio', selectedActor, options);
  const command = (change) =>
    store.executeTeam(
      {
        itemId: 'studio',
        requestId: randomUUID(),
        expectedRevision: store.readTeam('studio', actor).revision,
        ...change,
      },
      actor,
    );
  const link = (conversationId, role = 'contributor', reportsToMembershipId = null) =>
    command({
      operation: 'link',
      conversationId,
      role,
      displayName: `Named ${conversationId}`,
      responsibility: 'Deliver the selected work',
      reportsToMembershipId,
    });
  return {
    canonical,
    actor,
    available,
    read,
    command,
    link,
    get store() {
      return store;
    },
    restart() {
      store.close();
      stores.splice(stores.indexOf(store), 1);
      store = open();
    },
  };
}

describe.each(['fresh', 'upgraded'])('canonical current-work seam (%s database)', (variant) => {
  it('does not infer team or read authority from formal roles and supports explicit Symposium responsibility', () => {
    const f = fixture(variant);
    f.store.execute(
      {
        itemId: 'studio',
        requestId: randomUUID(),
        expectedRevision: f.store.read('studio', f.actor).revision,
        operation: 'setup_role',
        role: 'lead',
        conversationId: 'planning',
        expectedAssignmentRevision: 0,
      },
      f.actor,
    );
    expect(f.read().counts).toEqual({ current: 0, former: 0 });
    const formal = f.store.read('studio', f.actor);
    const receipt = f.link('shared-discussion', 'reviewer');
    expect(f.read()).toMatchObject({
      teamRevision: receipt.team.revision,
      participants: [
        {
          displayName: 'Named shared-discussion',
          role: 'reviewer',
          state: 'current',
          operationId: receipt.commandId,
        },
      ],
      coordination: {
        dependencies: { state: 'unknown' },
        blockers: { state: 'unknown' },
        nextAction: { state: 'unknown' },
        prReviewEvidence: { state: 'unknown' },
      },
    });
    expect(() => f.read({}, { kind: 'conversation', id: 'shared-discussion' })).toThrow(
      /operator/i,
    );
    expect(() => f.store.read('studio', { kind: 'conversation', id: 'shared-discussion' })).toThrow(
      /authorized/i,
    );
    expect(f.store.read('studio', f.actor)).toEqual(formal);
    expect(f.canonical.events.getOrdinaryInitialCommandId('planning')).toBeUndefined();
  });

  it('retains exact transition identity after owner replacement, unlink and restart without reviving former reporting routes', () => {
    const f = fixture(variant);
    const original = f.link('planning', 'slice_owner').team.members[0];
    f.link('reviewer', 'reviewer', original.membershipId);
    expect(
      f.read().participants.find((m) => m.conversationId === 'reviewer').reportingTo,
    ).toMatchObject({ state: 'current', conversationId: 'planning' });
    const replaced = f.command({
      operation: 'replace',
      membershipId: original.membershipId,
      conversationId: 'next-owner',
      role: 'slice_owner',
      displayName: 'Named next owner',
      responsibility: 'Continue the selected work',
      reportsToMembershipId: null,
    });
    f.restart();
    expect(f.read().participants.find((m) => m.conversationId === 'reviewer').reportingTo).toEqual({
      state: 'former',
      membershipId: original.membershipId,
      conversationId: null,
    });
    expect(f.read({ state: 'former' }).participants[0]).toMatchObject({
      membershipId: original.membershipId,
      operationId: replaced.commandId,
      state: 'former',
    });
    const next = f.store
      .readTeam('studio', f.actor)
      .members.find((m) => m.conversationId === 'next-owner');
    const input = {
      itemId: 'studio',
      requestId: randomUUID(),
      expectedRevision: f.store.readTeam('studio', f.actor).revision,
      operation: 'unlink',
      membershipId: next.membershipId,
    };
    const unlinked = f.store.executeTeam(input, f.actor);
    f.available.delete('next-owner');
    f.link('shared-discussion', 'investigator');
    f.restart();
    expect(f.store.executeTeam(input, f.actor)).toEqual(unlinked);
    expect(f.read().teamRevision).not.toBe(unlinked.team.revision);
    expect(
      f
        .read()
        .participants.some(
          (m) => m.conversationId === 'planning' || m.conversationId === 'next-owner',
        ),
    ).toBe(false);
    expect(
      f.read({ state: 'former' }).participants.find((m) => m.membershipId === next.membershipId)
        .operationId,
    ).toBe(unlinked.commandId);
    expect(f.store.read('studio', f.actor).assignments).toEqual([]);
  });

  it('fences compact pages against canonical membership changes and preserves independent operator checks', () => {
    const f = fixture(variant);
    for (let i = 0; i < 12; i++) {
      const id = `contributor-${i}`;
      f.available.add(id);
      f.link(id);
    }
    const first = f.read();
    expect(first.participants).toHaveLength(10);
    expect(first.nextOffset).toBe(10);
    f.restart();
    expect(
      f.read({ offset: 10, expectedTeamRevision: first.teamRevision }).participants,
    ).toHaveLength(2);
    expect(() => f.read({}, { kind: 'conversation', id: 'contributor-0' })).toThrow(/operator/i);
    f.command({ operation: 'unlink', membershipId: first.participants[0].membershipId });
    expect(() => f.read({ offset: 10, expectedTeamRevision: first.teamRevision })).toThrow(
      /changed/i,
    );
    expect(f.read().counts).toEqual({ current: 11, former: 1 });
  });
});
