import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SpecialistConsultationStore } from '../specialist-consultation-store.js';
import {
  SpecialistAuthorizationInputSchema,
  SpecialistRouteInputSchema,
} from '../specialist-consultation-contract.js';

const stores: SpecialistConsultationStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
function fixture() {
  const store = new SpecialistConsultationStore(':memory:');
  stores.push(store);
  const policy = store.authorize('lead', 'login', {
    requestId: randomUUID(),
    expiresAt: Date.now() + 60000,
    maxConsultations: 2,
    maxContextBytes: 32000,
    repository: 'example/project',
    connectionId: 'connection',
    routes: [
      {
        role: 'planner',
        agent: { profileId: 'planner', revision: 1 },
        accountId: 'configured-account',
        model: 'configured-model',
        reasoningEffort: null,
        runOn: 'local',
        targetId: 'configured-target',
        profileHash: 'a'.repeat(64),
        provider: 'openai',
        accountRevision: 'configured-revision',
      },
    ],
  });
  return { store, policy };
}
const intent = () => ({
  requestId: randomUUID(),
  role: 'planner',
  assignment: 'Plan the change',
  messageIds: [],
  artifacts: [],
});

it('preserves selected agent permission modes and accepts removable call allowances', () => {
  const { policy } = fixture();
  for (const permissionMode of ['ask', 'agent', 'auto']) {
    const { agent, accountId, model, reasoningEffort, runOn, targetId, role } = policy.routes[0];
    const route = {
      agent,
      accountId,
      model,
      reasoningEffort,
      runOn,
      targetId,
      role,
      permissionMode,
    };
    expect(SpecialistRouteInputSchema.parse(route).permissionMode).toBe(permissionMode);
    for (const maxConsultations of [null, 25]) {
      expect(
        SpecialistAuthorizationInputSchema.parse({
          requestId: randomUUID(),
          repository: policy.repository,
          connectionId: policy.connectionId,
          routes: [route],
          maxConsultations,
        }).maxConsultations,
      ).toBe(maxConsultations);
    }
  }
});

it('releases proven pre-dispatch refusals but retains uncertain dispatched allowance', () => {
  const { store, policy } = fixture();
  const boundary = { sequence: 10, messageId: null };
  const first = store.reserve('lead', 'login', policy.policyId, intent(), boundary);
  store.update('lead', first.requestId, first.revision, {
    state: 'uncertain',
    allowanceState: 'released',
  });
  const second = store.reserve('lead', 'login', policy.policyId, intent(), boundary);
  store.update('lead', second.requestId, second.revision, {
    state: 'uncertain',
    allowanceState: 'charged',
  });
  const third = store.reserve('lead', 'login', policy.policyId, intent(), boundary);
  expect(third.attemptOrdinal).toBe(2);
  expect(() => store.reserve('lead', 'login', policy.policyId, intent(), boundary)).toThrow(
    /budget/,
  );
  expect(() => store.claimAllowance('lead', 'login', first.requestId)).toThrow(/budget/);
});

it('retains the preflight envelope in the initial reservation and never substitutes retry evidence', () => {
  const { store, policy } = fixture();
  const input = intent();
  const boundary = { sequence: 10, messageId: null };
  const envelope = { version: 1, text: 'Exact frozen attributed evidence' };
  const first = store.reserve('lead', 'login', policy.policyId, input, boundary, policy.routes[0], {
    contextEnvelope: envelope,
  });
  expect(first).toMatchObject({ revision: 0, contextEnvelope: envelope });
  expect(store.read('lead', first.requestId).contextEnvelope).toEqual(envelope);
  expect(
    store.reserve('lead', 'login', policy.policyId, input, boundary, policy.routes[0], {
      contextEnvelope: { version: 1, text: 'Changed evidence' },
    }),
  ).toEqual(first);
});

it('atomically retains original operation identities, bounds recruitment and rejects changed retries', () => {
  const { store, policy } = fixture();
  const input = intent();
  const first = store.reserve('lead', 'login', policy.policyId, input, {
    sequence: 10,
    messageId: null,
  });
  expect(
    store.reserve('lead', 'login', policy.policyId, input, { sequence: 99, messageId: null }),
  ).toEqual(first);
  expect(first).toMatchObject({ state: 'reserved', input, boundary: { sequence: 10 } });
  expect(() =>
    store.reserve(
      'lead',
      'login',
      policy.policyId,
      { ...input, assignment: 'Changed' },
      first.boundary,
    ),
  ).toThrow(/conflict/);
  store.reserve('lead', 'login', policy.policyId, intent(), first.boundary);
  expect(() => store.reserve('lead', 'login', policy.policyId, intent(), first.boundary)).toThrow(
    /budget/,
  );
  expect(store.read('lead', first.requestId)).toEqual(first);
  expect(() => store.read('other-lead', first.requestId)).toThrow(/not found/);
});

it('revokes future work without erasing known activity or allowing a new login to inherit spending', () => {
  const { store, policy } = fixture();
  const first = store.reserve('lead', 'login', policy.policyId, intent(), {
    sequence: 10,
    messageId: null,
  });
  expect(() =>
    store.reserve('lead', 'replacement-login', policy.policyId, intent(), first.boundary),
  ).toThrow(/authorization/);
  store.revoke('lead', policy.policyId);
  expect(store.read('lead', first.requestId)).toEqual(first);
  expect(() => store.assertPolicy('lead', 'login', policy.policyId)).toThrow(/revoked/);
});

it('edits or removes an existing policy allowance without changing its original request or consumed receipts', () => {
  const { store, policy } = fixture();
  const boundary = { sequence: 1, messageId: null };
  store.reserve('lead', 'login', policy.policyId, intent(), boundary);
  store.reserve('lead', 'login', policy.policyId, intent(), boundary);
  const edit = { requestId: randomUUID(), expectedRevision: 0, maxConsultations: null };
  const updated = store.editAllowance('lead', 'login', policy.policyId, edit);
  expect(updated.maxConsultations).toBeNull();
  expect(store.editAllowance('lead', 'login', policy.policyId, edit)).toEqual(updated);
  expect(() => store.editAllowance('lead', 'another-login', policy.policyId, edit)).toThrow(
    /authorization/,
  );
  expect(() =>
    store.editAllowance('lead', 'login', policy.policyId, { ...edit, requestId: randomUUID() }),
  ).toThrow(/revision conflict/);
  expect(store.reserve('lead', 'login', policy.policyId, intent(), boundary).attemptOrdinal).toBe(
    2,
  );
  store.editAllowance('lead', 'login', policy.policyId, {
    requestId: randomUUID(),
    expectedRevision: 1,
    maxConsultations: 1,
  });
  expect(() => store.reserve('lead', 'login', policy.policyId, intent(), boundary)).toThrow(
    /budget/,
  );
});

it('fences concurrent phase changes and keeps stopped and uncertain operations inspectable', () => {
  const { store, policy } = fixture();
  const first = store.reserve('lead', 'login', policy.policyId, intent(), {
    sequence: 10,
    messageId: null,
  });
  const stopped = store.update('lead', first.requestId, first.revision, { state: 'stopped' });
  expect(() =>
    store.update('lead', first.requestId, first.revision, { state: 'joined', sessionId: 'worker' }),
  ).toThrow(/conflict/);
  expect(store.read('lead', first.requestId)).toEqual(stopped);
});
