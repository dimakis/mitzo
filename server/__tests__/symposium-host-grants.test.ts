import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SymposiumConfig } from '@mitzo/protocol';
import { SymposiumHostGrants } from '../symposium-host-grants.js';

let directory: string;
let grants: SymposiumHostGrants;
let config: SymposiumConfig;
let generation: number;
let active: boolean;
let unavailable: boolean;
const makeDeps = () => ({
  getConfig: () => config,
  commitConfig: (_id: string, next: SymposiumConfig, expected: number) => {
    if (config.revision !== expected) throw new Error('Revision conflict');
    config = next;
    return config;
  },
  getMembership: () => ({
    generation,
    state: active ? ('active' as const) : ('suspended' as const),
  }),
  validateSelection: () => {
    if (unavailable) throw new Error('Account unavailable');
  },
  resolveProfile: vi.fn((selection: { profileId: string; revision: number }) =>
    selection.profileId === 'owner-review' && selection.revision === 2
      ? {
          profileId: 'owner-review',
          revision: 2,
          definition: {
            name: 'Owner Reviewer',
            role: 'reviewer' as const,
            instructions: 'Review the implementation',
            expectedOutput: 'Findings with evidence',
            acceptanceCriteria: ['Every finding has evidence'],
            modelPolicyRole: 'reviewer',
          },
        }
      : selection.profileId === 'owner-coder' && selection.revision === 1
        ? {
            profileId: 'owner-coder',
            revision: 1,
            definition: {
              name: 'Owner Coder',
              role: 'coder' as const,
              instructions: 'Implement the approved change',
              expectedOutput: 'Working patch',
              acceptanceCriteria: ['Focused checks pass'],
              modelPolicyRole: 'coder',
            },
          }
        : null,
  ),
  authorizeSeat: vi.fn(
    ({ seat, contextSourceRefs }: { seat: { role: string }; contextSourceRefs: string[] }) => {
      if (contextSourceRefs.some((ref) => ref !== 'session:chat'))
        throw new Error('Context not authorized');
      const mode = seat.role === 'builder' ? ('write' as const) : ('read' as const);
      return {
        classification: 'mixed' as const,
        sourceRefs: contextSourceRefs,
        authority: { filesystem: mode, tools: mode, network: 'restricted' as const },
      };
    },
  ),
});

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mitzo-host-grants-'));
  generation = 1;
  active = true;
  unavailable = false;
  config = {
    version: 2,
    revision: 1,
    state: 'draft',
    anchorSeatId: 'architect',
    activeSeatCap: 3,
    seats: ['architect', 'reviewer', 'builder'].map((role, index) => ({
      id: role,
      name: role,
      role,
      systemPrompt: `Act as ${role}`,
      color: '#123456',
      model: `model-${index}`,
      accountBinding: {
        accountId: `account-${index}`,
        accountLabel: `Account ${index}`,
        provider: 'openai-codex' as const,
        model: `model-${index}`,
        profileRevision: 'account-v1',
      },
    })),
    turnRules: { mode: 'directed', maxTurns: 8 },
    interceptMode: 'manual',
  };
  grants = new SymposiumHostGrants(join(directory, 'events.db'), makeDeps());
});
afterEach(() => {
  grants.close();
  rmSync(directory, { recursive: true, force: true });
});

it('mints immutable host grants, activates with CAS, and verifies exact seat authority', () => {
  const result = grants.activate({ sessionId: 'chat', expectedRevision: 1, actor: 'owner' });
  expect(result).toMatchObject({ state: 'active', revision: 2 });
  expect(result.seats[1].authorityGrant).toMatchObject({ filesystem: 'read', tools: 'read' });
  expect(result.seats[2].authorityGrant).toMatchObject({ filesystem: 'write' });
  expect(new Set(result.seats.map((seat) => seat.isolationRequest!.trustDomainId)).size).toBe(1);
  expect(() =>
    grants.verifySeat({ sessionId: 'chat', seat: result.seats[1], membershipGeneration: 1 }),
  ).not.toThrow();
  grants.close();
  grants = new SymposiumHostGrants(join(directory, 'events.db'), makeDeps());
  expect(() =>
    grants.verifySeat({ sessionId: 'chat', seat: result.seats[1], membershipGeneration: 1 }),
  ).not.toThrow();
});

it('rejects forged grants, changed prompts, account revisions, and cross-session reuse', () => {
  grants.activate({ sessionId: 'chat', expectedRevision: 1, actor: 'owner' });
  const seat = config.seats[1];
  for (const changed of [
    { ...seat, systemPrompt: 'Write files' },
    { ...seat, authorityGrant: { ...seat.authorityGrant!, filesystem: 'write' as const } },
    { ...seat, accountBinding: { ...seat.accountBinding!, profileRevision: 'account-v2' } },
  ])
    expect(() =>
      grants.verifySeat({ sessionId: 'chat', seat: changed, membershipGeneration: 1 }),
    ).toThrow();
  expect(() => grants.verifySeat({ sessionId: 'other', seat, membershipGeneration: 1 })).toThrow();
});

it('fences revoked grants, suspended membership, stale generations, and disabled accounts', () => {
  grants.activate({ sessionId: 'chat', expectedRevision: 1, actor: 'owner' });
  const seat = config.seats[1];
  const verify = () => grants.verifySeat({ sessionId: 'chat', seat, membershipGeneration: 1 });
  generation = 2;
  expect(verify).toThrow();
  generation = 1;
  active = false;
  expect(verify).toThrow();
  active = true;
  unavailable = true;
  expect(verify).toThrow();
  unavailable = false;
  grants.revoke({
    sessionId: 'chat',
    authorityGrantId: seat.authorityGrant!.grantId,
    actor: 'owner',
    reason: 'Permission withdrawn',
  });
  expect(verify).toThrow(/revoked/i);
});

it('refuses stale activation, unapproved context, and draft-supplied authority', () => {
  expect(() => grants.activate({ sessionId: 'chat', expectedRevision: 0, actor: 'owner' })).toThrow(
    /revision/i,
  );
  expect(() =>
    grants.activate({
      sessionId: 'chat',
      expectedRevision: 1,
      actor: 'owner',
      contextSourceRefs: ['session:other'],
    }),
  ).toThrow(/context/i);
  config.seats[0].authorityGrant = {
    grantId: 'forged',
    revision: 1,
    filesystem: 'write',
    tools: 'write',
    network: 'restricted',
  };
  expect(() => grants.activate({ sessionId: 'chat', expectedRevision: 1, actor: 'owner' })).toThrow(
    /grant/i,
  );
  expect(config.state).toBe('draft');
});

it('reissues a suspended seat with fresh grants in the existing shared domain', () => {
  grants.activate({ sessionId: 'chat', expectedRevision: 1, actor: 'owner' });
  const previous = config.seats[1];
  const previousAnchor = config.seats[0];
  const draftSeat = { ...previous };
  delete draftSeat.profileBinding;
  delete draftSeat.contextGrant;
  delete draftSeat.authorityGrant;
  delete draftSeat.isolationRequest;
  const revised = {
    ...draftSeat,
    model: 'new-model',
    accountBinding: { ...draftSeat.accountBinding!, model: 'new-model' },
  };
  expect(() =>
    grants.reviseSeat({ sessionId: 'chat', expectedRevision: 2, actor: 'owner', seat: revised }),
  ).toThrow(/suspend|active/i);
  active = false;
  const result = grants.reviseSeat({
    sessionId: 'chat',
    expectedRevision: 2,
    actor: 'owner',
    seat: revised,
  });
  expect(result.revision).toBe(3);
  expect(result.seats[1].authorityGrant!.grantId).not.toBe(previous.authorityGrant!.grantId);
  expect(result.seats[1].isolationRequest).toEqual(previous.isolationRequest);
  expect(result.seats[0]).toEqual(previousAnchor);
  active = true;
  generation = 2;
  expect(() =>
    grants.verifySeat({ sessionId: 'chat', seat: result.seats[1], membershipGeneration: 2 }),
  ).not.toThrow();
  expect(() =>
    grants.verifySeat({ sessionId: 'chat', seat: previous, membershipGeneration: 2 }),
  ).toThrow();
});

it('resolves exact owner profile revisions into immutable host grants', () => {
  const activated = grants.activate({
    sessionId: 'chat',
    expectedRevision: 1,
    actor: 'owner',
    profileSelections: { reviewer: { profileId: 'owner-review', revision: 2 } },
  });
  const reviewer = activated.seats[1];
  expect(reviewer).toMatchObject({
    name: 'Owner Reviewer',
    role: 'reviewer',
    systemPrompt: 'Review the implementation',
    expectedOutput: 'Findings with evidence',
    acceptanceCriteria: ['Every finding has evidence'],
    profileBinding: { profileId: 'owner-review', profileRevision: '2' },
  });
  expect(reviewer.authorityGrant).toMatchObject({ filesystem: 'read', tools: 'read' });
  expect(() =>
    grants.verifySeat({
      sessionId: 'chat',
      seat: {
        ...reviewer,
        expectedOutput: 'Changed output',
      },
      membershipGeneration: 1,
    }),
  ).toThrow(/immutable/i);
});

it('rejects missing revisions, unknown seats and profile authority expansion', () => {
  expect(() =>
    grants.activate({
      sessionId: 'chat',
      expectedRevision: 1,
      actor: 'owner',
      profileSelections: { reviewer: { profileId: 'owner-review', revision: 3 } },
    }),
  ).toThrow(/not found/i);
  expect(() =>
    grants.activate({
      sessionId: 'chat',
      expectedRevision: 1,
      actor: 'owner',
      profileSelections: { unknown: { profileId: 'owner-review', revision: 2 } },
    }),
  ).toThrow(/unknown seat/i);
  expect(() =>
    grants.activate({
      sessionId: 'chat',
      expectedRevision: 1,
      actor: 'owner',
      profileSelections: { reviewer: { profileId: 'owner-coder', revision: 1 } },
    }),
  ).toThrow(/authority ceiling/i);
  expect(config.state).toBe('draft');
});

it('attenuates writer authority when a reviewer profile is selected', () => {
  const activated = grants.activate({
    sessionId: 'chat',
    expectedRevision: 1,
    actor: 'owner',
    profileSelections: { builder: { profileId: 'owner-review', revision: 2 } },
  });
  expect(activated.seats[2]).toMatchObject({
    role: 'reviewer',
    authorityGrant: { filesystem: 'read', tools: 'read' },
  });
});

it('refuses a resolver that returns a different owner profile revision', () => {
  grants.close();
  grants = new SymposiumHostGrants(join(directory, 'events.db'), {
    ...makeDeps(),
    resolveProfile: () => ({
      profileId: 'other-owner',
      revision: 2,
      definition: {
        name: 'Wrong profile',
        role: 'reviewer',
        instructions: 'Wrong instructions',
        expectedOutput: 'Wrong output',
        acceptanceCriteria: ['Wrong criterion'],
        modelPolicyRole: 'reviewer',
      },
    }),
  });
  expect(() =>
    grants.activate({
      sessionId: 'chat',
      expectedRevision: 1,
      actor: 'owner',
      profileSelections: { reviewer: { profileId: 'owner-review', revision: 2 } },
    }),
  ).toThrow(/different revision/i);
});
