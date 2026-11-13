import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SpecialistConsultationStore } from '../specialist-consultation-store.js';

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
