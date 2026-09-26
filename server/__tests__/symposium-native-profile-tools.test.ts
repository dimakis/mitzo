import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createSymposiumNativeProfileTools,
  assertSymposiumProfileAttemptCurrent,
} from '../symposium-native-profile-tools.js';
import { SymposiumProfileProposalStore } from '../symposium-profile-proposals.js';
import { SymposiumProfileStore } from '../symposium-profiles.js';
import type { SymposiumSeatExecution } from '../symposium-orchestrator.js';

let directory: string;
let store: SymposiumProfileProposalStore;
let profiles: SymposiumProfileStore;
const arguments_ = {
  suggestedProfileId: 'builder',
  definition: {
    name: 'Builder',
    role: 'coder',
    instructions: 'Implement reviewed changes.',
    expectedOutput: 'A tested patch',
    acceptanceCriteria: ['Focused tests pass'],
    modelPolicyRole: 'coder',
  },
};
const context = { turnId: 'provider-turn', callId: 'provider-call' };
function fixture(seatId = 'writer', claimToken = 'claim') {
  const controller = new AbortController();
  const verifyCurrent = vi.fn();
  const execution = {
    sessionId: 'session',
    claimToken,
    seat: { id: seatId },
    provenance: { membershipGeneration: 1 },
    signal: controller.signal,
  } as SymposiumSeatExecution;
  return {
    controller,
    verifyCurrent,
    ...createSymposiumNativeProfileTools({ store, owner: 'user', execution, verifyCurrent }),
  };
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'symposium-native-profile-'));
  store = new SymposiumProfileProposalStore(join(directory, 'events.db'));
  profiles = new SymposiumProfileStore(join(directory, 'events.db'));
});
afterEach(() => {
  store.close();
  profiles.close();
  rmSync(directory, { recursive: true, force: true });
});
it('creates an owner/session scoped durable draft, deduplicates verified calls, and never saves automatically', async () => {
  const tool = fixture();
  expect(tool.tools.map((t) => t.name)).toEqual(['SymposiumProposeProfile']);
  expect(tool.instructions).toContain('user must review and Save');
  const signal = new AbortController().signal;
  const first = await tool.executeTool('SymposiumProposeProfile', arguments_, signal, context);
  expect(first.isError).toBe(false);
  expect(JSON.parse(first.content).status).toBe('awaiting_user_review');
  expect(await tool.executeTool('SymposiumProposeProfile', arguments_, signal, context)).toEqual(
    first,
  );
  expect(tool.verifyCurrent).toHaveBeenCalledTimes(2);
  expect(store.listPending('user', 'session')).toHaveLength(1);
  expect(store.listPending('other', 'session')).toEqual([]);
  expect(store.listPending('user', 'other')).toEqual([]);
  expect(profiles.list('user')).toEqual([]);
  store.close();
  store = new SymposiumProfileProposalStore(join(directory, 'events.db'));
  expect(store.listPending('user', 'session')[0].proposalId).toBe(
    JSON.parse(first.content).proposalId,
  );
});
it('separates provider call IDs reused across seats and attempt restarts', async () => {
  for (const tool of [fixture(), fixture('reviewer'), fixture('writer', 'retry-claim')])
    expect(
      (
        await tool.executeTool(
          'SymposiumProposeProfile',
          arguments_,
          new AbortController().signal,
          context,
        )
      ).isError,
    ).toBe(false);
  expect(store.listPending('user', 'session')).toHaveLength(3);
});
it('rejects revoked membership/grants, cancellation, unknown tools and invalid portable fields without writes', async () => {
  const revoked = fixture();
  revoked.verifyCurrent.mockImplementation(() => {
    throw new Error('Seat removed or grant revoked');
  });
  const aborted = fixture();
  aborted.controller.abort();
  const request = new AbortController();
  request.abort();
  for (const [tool, name, args, signal, ids] of [
    [revoked, 'SymposiumProposeProfile', arguments_, new AbortController().signal, context],
    [aborted, 'SymposiumProposeProfile', arguments_, new AbortController().signal, context],
    [fixture(), 'SymposiumProposeProfile', arguments_, request.signal, context],
    [fixture(), 'SaveProfile', arguments_, new AbortController().signal, context],
    [
      fixture(),
      'SymposiumProposeProfile',
      { ...arguments_, owner: 'other' },
      new AbortController().signal,
      context,
    ],
    [
      fixture(),
      'SymposiumProposeProfile',
      arguments_,
      new AbortController().signal,
      { turnId: '', callId: '' },
    ],
  ] as const)
    expect((await tool.executeTool(name, args, signal, ids)).isError).toBe(true);
  expect(store.listPending('user', 'session')).toEqual([]);
});

it('reads only host-owner catalog summaries and exact saved revisions, with strict read inputs', async () => {
  const definition = { ...arguments_.definition, role: 'coder' as const };
  profiles.save('user', {
    profileId: 'builder',
    expectedRevision: 0,
    idempotencyKey: 'v1',
    definition,
  });
  profiles.save('user', {
    profileId: 'builder',
    expectedRevision: 1,
    idempotencyKey: 'v2',
    definition: { ...definition, instructions: 'Updated portable guidance' },
  });
  profiles.save('other', {
    profileId: 'private',
    expectedRevision: 0,
    idempotencyKey: 'other',
    definition,
  });
  const verifyCurrent = vi.fn();
  const tool = createSymposiumNativeProfileTools({
    store,
    catalogStore: profiles,
    owner: 'user',
    verifyCurrent,
    execution: {
      sessionId: 'session',
      claimToken: 'claim',
      seat: { id: 'writer' },
      provenance: { membershipGeneration: 1 },
      signal: new AbortController().signal,
    } as SymposiumSeatExecution,
  });
  expect(tool.tools.map((t) => t.name)).toEqual([
    'SymposiumProposeProfile',
    'SymposiumReadProfiles',
  ]);
  const read = (args: Record<string, string | number>) =>
    tool.executeTool('SymposiumReadProfiles', args, new AbortController().signal, context);
  const list = JSON.parse((await read({ action: 'list' })).content);
  expect(list.profiles).toHaveLength(1);
  expect(list.profiles[0]).toMatchObject({ profileId: 'builder', revision: 2, name: 'Builder' });
  expect(list.profiles[0]).not.toHaveProperty('definition');
  const exact = JSON.parse(
    (await read({ action: 'get', profileId: 'builder', revision: 1 })).content,
  );
  expect(exact.definition.instructions).toBe(definition.instructions);
  expect((await read({ action: 'get', profileId: 'private' })).isError).toBe(true);
  expect((await read({ action: 'get', profileId: 'builder', owner: 'other' })).isError).toBe(true);
  expect((await read({ action: 'get', profileId: 'builder', revision: 0 })).isError).toBe(true);
  expect((await read({ action: 'save', profileId: 'builder' })).isError).toBe(true);
  expect((await read({ action: 'get' })).isError).toBe(true);
  expect((await read({ action: 'get', profileId: 'builder', offset: 1 })).isError).toBe(true);
  expect((await read({ action: 'list', profileId: 'builder' })).isError).toBe(true);
  expect((await read({ action: 'list', revision: 1 })).isError).toBe(true);
  expect(tool.tools[1].input_schema).toMatchObject({ type: 'object' });
  verifyCurrent.mockImplementation(() => {
    throw new Error('Revoked claim');
  });
  expect((await read({ action: 'list' })).isError).toBe(true);
  expect(store.listPending('user', 'session')).toEqual([]);
});

it('fences tool calls to the exact durable executing claim after retries or cleanup', () => {
  const execution = {
    deliveryId: 'delivery',
    claimToken: 'old-claim',
    seat: { id: 'writer' },
    provenance: { membershipGeneration: 1 },
  } as SymposiumSeatExecution;
  const matching = {
    status: 'executing',
    deliveryId: 'delivery',
    seatId: 'writer',
    provenance: execution.provenance,
  };
  const getSymposiumRecipientAttemptByClaimToken = vi.fn().mockReturnValue(matching);
  const facts = { getSymposiumRecipientAttemptByClaimToken };
  expect(() => assertSymposiumProfileAttemptCurrent(facts, execution)).not.toThrow();
  expect(getSymposiumRecipientAttemptByClaimToken).toHaveBeenCalledWith('old-claim');
  for (const stale of [
    undefined,
    { ...matching, status: 'cancelled' },
    { ...matching, status: 'succeeded' },
    { ...matching, deliveryId: 'other' },
    { ...matching, seatId: 'other' },
    { ...matching, provenance: { membershipGeneration: 2 } },
  ]) {
    getSymposiumRecipientAttemptByClaimToken.mockReturnValue(stale);
    expect(() => assertSymposiumProfileAttemptCurrent(facts, execution)).toThrow(
      'no longer active',
    );
  }
});
