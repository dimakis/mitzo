import { afterEach, expect, it, vi } from 'vitest';
import { createPreparationAttemptDiagnostics } from './fixtures/preparation-attempt-diagnostics.js';
import { observePreparationService } from './fixtures/preparation-service-diagnostics.js';
import {
  preparedRepositoryCandidateFixture,
  qualifiedPreparedRepositoryRecord,
} from './prepared-repository-candidate-fixture.js';
import { materializeQualifiedLocalRepositoryTask } from '../qualified-local-repository-actor.js';

vi.mock('../qualified-local-repository-actor.js', () => ({
  materializeQualifiedLocalRepositoryTask: vi.fn(),
}));
const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(materializeQualifiedLocalRepositoryTask).mockReset();
  for (const close of cleanups.splice(0).reverse()) close();
});

// Real service/SQLite/schema translation, with explicit synthetic metadata owner
// and mocked actor. No native execution, physical authority or creation proof.
function fixture() {
  const f = preparedRepositoryCandidateFixture(cleanups);
  const record = qualifiedPreparedRepositoryRecord(f.pending(), f.input);
  record.qualifiedLocalPreparation!.allocationFacts = {
    ...record.qualifiedLocalPreparation!.allocationFacts,
    existingDirectories: [],
  };
  // Keep the actual JSON/facts hash internally consistent for the service check.
  const digest = (value: unknown) =>
    import('../pending-host-task.js').then((m) => m.pendingHostTaskDecisionHash(value));
  const receiptIdentity = record.pendingHostTask!.taskIdentity!;
  record.pendingHostTask!.state = 'reserved';
  delete record.pendingHostTask!.taskIdentity;
  record.pendingHostTaskDecision!.state = 'finalized';
  record.pendingHostTaskDecision!.evidence.expiresAt = Date.now() + 120000;
  const owner = {
    context: {},
    assertCurrentSync() {},
    async assertCurrent() {},
    publicationPackedRefs: Object.freeze({ kind: 'absent' }),
  };
  const internal = f.service as unknown as {
    assertDecisionOwner(): unknown;
    decisionScope(): unknown;
    decisionEvidence(): unknown;
  };
  vi.spyOn(internal, 'assertDecisionOwner').mockReturnValue({
    rootIdentity: record.pendingHostTask!.rootIdentity,
  });
  vi.spyOn(internal, 'decisionScope').mockImplementation(
    () => record.pendingHostTaskDecision!.scope,
  );
  vi.spyOn(internal, 'decisionEvidence').mockImplementation(
    () => record.pendingHostTaskDecision!.evidence,
  );
  return { ...f, record, receiptIdentity, owner, digest };
}

it.each(['actor', 'schema', 'bound', 'cas', 'success'] as const)(
  'records the actual %s service path and keeps private errors out of public data',
  async (failure) => {
    const f = fixture();
    const factsSha = await f.digest(f.record.qualifiedLocalPreparation!.allocationFacts);
    f.record.sourceDigest = f.record.pendingHostTask!.sourceDigest = factsSha;
    f.record.qualifiedLocalPreparation!.allocationFactsSha256 = factsSha;
    f.record.pendingHostTaskDecision!.scope.allocationFactsSha256 = factsSha;
    f.record.pendingHostTaskDecision!.scope.sourceDigest = factsSha;
    f.save(f.record);
    const diagnostics = createPreparationAttemptDiagnostics();
    const serviceState = observePreparationService(diagnostics, f.service);
    const operation = f.service.beginPendingHostTaskDecisionMaterialization(
      f.record.pendingHostTask!.request,
      f.owner as never,
    );
    const cause = Error('injected original actor failure');
    vi.mocked(materializeQualifiedLocalRepositoryTask).mockImplementation(async () => {
      if (failure === 'actor') throw cause;
      return {
        taskIdentity: failure === 'schema' ? { root: 'invalid' } : f.receiptIdentity,
        publication: failure === 'bound' ? { oversize: 'x'.repeat(300000) } : { version: 1 },
      } as never;
    });
    if (failure === 'cas')
      f.db.exec(`CREATE TRIGGER refuse_materialized BEFORE UPDATE ON repository_workspaces
      WHEN json_extract(NEW.record,'$.pendingHostTask.state')='materialized'
      BEGIN SELECT RAISE(ABORT,'fixture cas refusal'); END;`);
    let error: unknown, receipt: unknown;
    try {
      receipt = await f.service.materializeQualifiedPendingHostTask(
        f.record.pendingHostTask!.request,
        operation,
      );
    } catch (caught) {
      error = caught;
    }
    if (failure === 'success') {
      expect(error).toBeUndefined();
      expect(receipt).toMatchObject({ state: 'materialized' });
      expect(serviceState().receipt).toMatchObject({ status: 'returned', state: 'materialized' });
      expect(serviceState().cas.zeroChanges).toBe(0);
      expect(diagnostics.snapshot().stages['service-materialize'].returned).toBe(1);
      const saved = JSON.parse(
        (
          f.db.prepare('SELECT record FROM repository_workspaces WHERE id=?').get(f.record.id) as {
            record: string;
          }
        ).record,
      );
      expect(saved.pendingHostTask.state).toBe('materialized');
      expect(saved.qualifiedLocalPreparation.publication).toEqual({ version: 1 });
      return;
    }
    expect(error).toMatchObject({
      code: 'pending_host_task_uncertain',
      message: 'pending_host_task_uncertain',
    });
    const original = (error as Error).cause;
    expect(original).toBeDefined();
    if (failure === 'actor') expect(original).toBe(cause);
    if (failure === 'schema' || failure === 'bound')
      expect(original).toMatchObject({ name: 'ZodError' });
    if (failure === 'cas') expect(original).toMatchObject({ code: 'SQLITE_CONSTRAINT_TRIGGER' });
    expect(JSON.stringify(error)).toBe('{"code":"pending_host_task_uncertain"}');
    expect(serviceState().receipt).toEqual({ status: 'not-reached' });
    const row = JSON.parse(
      (
        f.db.prepare('SELECT record FROM repository_workspaces WHERE id=?').get(f.record.id) as {
          record: string;
        }
      ).record,
    );
    expect(row.pendingHostTask.state).toBe('materializing');
    expect(row.qualifiedLocalPreparation.publication).toBeUndefined();
    expect(
      diagnostics.snapshot().stages['service-materialize'].errors[0].cause?.messageSha256,
    ).toBeDefined();
    if (failure === 'schema')
      expect(diagnostics.snapshot().stages['receipt-schema'].errors).toHaveLength(1);
    if (failure === 'cas') expect(diagnostics.snapshot().stages['row-cas'].errors).toHaveLength(1);
  },
);
