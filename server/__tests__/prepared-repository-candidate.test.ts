import { afterEach, expect, it } from 'vitest';
import { assertPreparedRepositoryMaterializedRecordBound } from '../repository-workspaces.js';
import {
  pendingHostTaskDecisionHash,
  pendingHostTaskDecisionPayload,
} from '../pending-host-task.js';
import { projectQualifiedPreparedRepositoryTransitionFacts } from '../qualified-prepared-repository-transition.js';
import {
  preparedRepositoryCandidateFixture,
  qualifiedPreparedRepositoryRecord as qualifiedRecord,
} from './prepared-repository-candidate-fixture.js';
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});

it('retains exact raw bytes and unknown record fields in a frozen read-only candidate without filesystem access', () => {
  const f = preparedRepositoryCandidateFixture(cleanups);
  const record = { ...f.pending(), retainedUnknownEvidence: { nested: ['original'] } };
  const raw = f.save(record);
  const selected = f.service.findPreparedRepositoryTransitionCandidate(f.input)!;
  expect(selected.record).toEqual(record);
  expect(selected.rawRecord).toBe(raw);
  expect(pendingHostTaskDecisionHash(selected.record)).toBe(
    pendingHostTaskDecisionHash(JSON.parse(raw)),
  );
  expect(Object.isFrozen(selected)).toBe(true);
  expect(Object.isFrozen(selected.record.pendingHostTask!.taskIdentity!.root)).toBe(true);
  expect(Object.isFrozen((selected.record as typeof record).retainedUnknownEvidence.nested)).toBe(
    true,
  );
  expect(f.db.prepare('SELECT record FROM repository_workspaces').all()).toEqual([{ record: raw }]);
  expect(f.authorize).not.toHaveBeenCalled();
});

it('returns no candidate for an absent exact native source tuple without scanning host paths', () => {
  const f = preparedRepositoryCandidateFixture(cleanups);
  f.save(f.pending());
  expect(
    f.service.findPreparedRepositoryTransitionCandidate({
      ...f.input,
      sourceTarget: { ...f.input.sourceTarget, turnId: 'other-turn' },
    }),
  ).toBeUndefined();
});

it('refuses multiple pending rows for the same completed source instead of selecting latest', () => {
  const f = preparedRepositoryCandidateFixture(cleanups);
  f.save(f.pending());
  f.save(f.pending());
  expect(() => f.service.findPreparedRepositoryTransitionCandidate(f.input)).toThrow(
    'pending_host_task_uncertain',
  );
});

it.each([
  'receiptRequest',
  'decision',
  'materialized',
  'primary',
  'adopted',
  'sourceDigest',
] as const)('refuses mismatched or ineligible %s evidence without rewriting the row', (change) => {
  const f = preparedRepositoryCandidateFixture(cleanups);
  const record = f.pending();
  if (change === 'receiptRequest')
    record.pendingHostTaskDecision!.request = {
      ...record.pendingHostTaskDecision!.request,
      prepareCallId: 'other-call',
    };
  if (change === 'decision') record.pendingHostTaskDecision!.state = 'uncertain';
  if (change === 'materialized') {
    record.pendingHostTask!.state = 'materializing';
    delete record.pendingHostTask!.taskIdentity;
  }
  if (change === 'primary') record.conversationId = f.input.conversationId;
  if (change === 'adopted') Object.assign(record, { preparedRepositoryTransitionAdoption: {} });
  if (change === 'sourceDigest') record.sourceDigest = 'f'.repeat(64);
  const raw = f.save(record, change === 'primary' ? f.input.conversationId : null);
  expect(() => f.service.findPreparedRepositoryTransitionCandidate(f.input)).toThrow(
    'pending_host_task_ownership_changed',
  );
  expect(f.db.prepare('SELECT record FROM repository_workspaces').all()).toEqual([{ record: raw }]);
});

it('filters exact account and old workspace before the bounded ambiguity check', () => {
  const f = preparedRepositoryCandidateFixture(cleanups);
  for (let index = 0; index < 3; index++) {
    const otherAccount = f.pending();
    otherAccount.binding = { ...otherAccount.binding, model: 'other-model' };
    f.save(otherAccount);
    const otherWorkspace = f.pending();
    otherWorkspace.pendingHostTaskDecision!.scope = {
      ...otherWorkspace.pendingHostTaskDecision!.scope,
      oldWorkspace: { ...f.input.oldWorkspace, id: 'other-owner' },
    };
    f.save(otherWorkspace);
  }
  expect(f.service.findPreparedRepositoryTransitionCandidate(f.input)).toBeUndefined();
  const original = f.pending();
  f.save(original);
  expect(f.service.findPreparedRepositoryTransitionCandidate(f.input)!.record.id).toBe(original.id);
});

it('refuses caller preparation IDs instead of using them as a selector', () => {
  const f = preparedRepositoryCandidateFixture(cleanups);
  const record = f.pending();
  f.save(record);
  expect(() =>
    f.service.findPreparedRepositoryTransitionCandidate({
      ...f.input,
      preparationId: record.id,
    } as never),
  ).toThrow('pending_host_task_invalid_input');
});

it('enforces the exact shared UTF-8 raw-record bound before returning a predictable unadoptable candidate', () => {
  expect(() => assertPreparedRepositoryMaterializedRecordBound('x'.repeat(262144))).not.toThrow();
  expect(() => assertPreparedRepositoryMaterializedRecordBound('é'.repeat(131073))).toThrow();
  const f = preparedRepositoryCandidateFixture(cleanups);
  const record = { ...f.pending(), retainedUnknownEvidence: 'x'.repeat(262144) };
  const raw = f.save(record);
  expect(() => f.service.findPreparedRepositoryTransitionCandidate(f.input)).toThrow();
  expect(f.db.prepare('SELECT record FROM repository_workspaces').all()).toEqual([{ record: raw }]);
});

// Explicit metadata-only materialization fixture: no filesystem/task/current
// authority or actual actor effects are inferred from these declared records.

it('projects immutable qualified transition DATA with the full original materialized-row digest only', () => {
  const f = preparedRepositoryCandidateFixture(cleanups);
  const record = {
    ...qualifiedRecord(f.pending(), f.input),
    retainedUnknown: { original: ['bytes'] },
  };
  f.save(record);
  const candidate = f.service.findPreparedRepositoryTransitionCandidate(f.input)!;
  const result = projectQualifiedPreparedRepositoryTransitionFacts(
    candidate,
    f.input,
    'f'.repeat(64),
  );
  expect(result.request).toEqual(candidate.request);
  expect(result.materializedRecordSha256).toBe(pendingHostTaskDecisionHash(record));
  expect(result.consumedScopeSha256).toBe(record.pendingHostTaskDecision!.scopeSha256);
  expect(result.newWorkspace.taskIdentity).toEqual(record.pendingHostTask!.taskIdentity);
  expect(result.oldWorkspace).toEqual(f.input.oldWorkspace);
  expect(result.resultSha256).toBe('f'.repeat(64));
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.newWorkspace.taskIdentity.root)).toBe(true);
  expect(Object.isFrozen(result.request.runtimeBinding.execution)).toBe(true);
  expect(f.authorize).not.toHaveBeenCalled();
  expect(f.db.prepare('SELECT record FROM repository_workspaces').get()).toEqual({
    record: candidate.rawRecord,
  });
});

it.each([
  'missing-qualified',
  'missing-scope-digest',
  'changed-old-workspace',
  'changed-result',
  'raw-row',
] as const)(
  'refuses unqualified transition DATA %s without new authority or row effects',
  (change) => {
    const f = preparedRepositoryCandidateFixture(cleanups);
    const record = qualifiedRecord(f.pending(), f.input);
    const originalRaw = f.save(record);
    const original = f.service.findPreparedRepositoryTransitionCandidate(f.input)!;
    if (change === 'missing-qualified') delete record.qualifiedLocalPreparation;
    if (change === 'missing-scope-digest') {
      delete record.pendingHostTaskDecision!.scope.allocationFactsSha256;
      const decision = record.pendingHostTaskDecision!;
      decision.scopeSha256 = pendingHostTaskDecisionHash(decision.scope);
      decision.evidence.input = pendingHostTaskDecisionPayload(decision.request, decision.scope);
      decision.evidence.inputSha256 = pendingHostTaskDecisionHash(decision.evidence.input);
    }
    const candidate = { ...original, record, rawRecord: JSON.stringify(record) };
    const selected =
      change === 'changed-old-workspace'
        ? { ...f.input, oldWorkspace: { ...f.input.oldWorkspace, id: 'other' } }
        : f.input;
    const supplied =
      change === 'raw-row' ? { ...candidate, rawRecord: candidate.rawRecord + 'x' } : candidate;
    expect(() =>
      projectQualifiedPreparedRepositoryTransitionFacts(
        supplied,
        selected,
        change === 'changed-result' ? 'not-a-sha' : 'f'.repeat(64),
      ),
    ).toThrow();
    expect(f.db.prepare('SELECT record FROM repository_workspaces').get()).toEqual({
      record: originalRaw,
    });
    expect(f.authorize).not.toHaveBeenCalled();
  },
);

it.each(['evidence-input', 'scope-create', 'root-identity', 'ordinary-runtime'] as const)(
  'refuses mismatched qualified transition correlation %s before a reservation can be considered',
  (change) => {
    const f = preparedRepositoryCandidateFixture(cleanups);
    const record = qualifiedRecord(f.pending(), f.input);
    f.save(record);
    const original = f.service.findPreparedRepositoryTransitionCandidate(f.input)!;
    const decision = record.pendingHostTaskDecision!;
    if (change === 'evidence-input') decision.evidence.input = {};
    if (change === 'scope-create') decision.scope.create.baseOid = 'f'.repeat(40);
    if (change === 'root-identity') decision.scope.taskRootIdentity.ino += 1;
    if (change === 'ordinary-runtime') {
      record.ordinaryPreparation!.runtimeBinding = structuredClone(
        record.ordinaryPreparation!.runtimeBinding,
      );
      record.ordinaryPreparation!.runtimeBinding.execution.targetId = 'different-target';
    }
    if (change === 'scope-create' || change === 'root-identity') {
      decision.scopeSha256 = pendingHostTaskDecisionHash(decision.scope);
      decision.evidence.input = pendingHostTaskDecisionPayload(decision.request, decision.scope);
      decision.evidence.inputSha256 = pendingHostTaskDecisionHash(decision.evidence.input);
    }
    const candidate = { ...original, record, rawRecord: JSON.stringify(record) };
    expect(() =>
      projectQualifiedPreparedRepositoryTransitionFacts(candidate, f.input, 'f'.repeat(64)),
    ).toThrow();
  },
);
