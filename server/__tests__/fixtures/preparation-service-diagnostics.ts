import { vi } from 'vitest';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { PendingHostTaskReceiptSchema } from '../../pending-host-task.js';
import type { RepositoryWorkspaces } from '../../repository-workspaces.js';
import type { PreparationAttemptDiagnostics } from './preparation-attempt-diagnostics.js';

/** Test-only finite probes. Original methods, arguments and receivers are used;
 * no record bytes, SQL bindings, paths or source values enter diagnostics. */
export function observePreparationService(
  diagnostics: PreparationAttemptDiagnostics,
  service: RepositoryWorkspaces,
) {
  let receipt: unknown = { status: 'not-reached' };
  const cas = { calls: 0, returned: 0, zeroChanges: 0 };
  const materialize = service.materializeQualifiedPendingHostTask;
  vi.spyOn(service, 'materializeQualifiedPendingHostTask').mockImplementation(async (...args) => {
    const value = await diagnostics.capture('service-materialize', () =>
      Reflect.apply(materialize, service, args),
    );
    receipt = {
      status: 'returned',
      state: value.state,
      sha256: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
      taskIdentitySha256: value.taskIdentity
        ? createHash('sha256').update(JSON.stringify(value.taskIdentity)).digest('hex')
        : null,
    };
    return value;
  });
  const parse = PendingHostTaskReceiptSchema.parse;
  vi.spyOn(PendingHostTaskReceiptSchema, 'parse').mockImplementation((...args) =>
    diagnostics.captureSync('receipt-schema', () =>
      Reflect.apply(parse, PendingHostTaskReceiptSchema, args),
    ),
  );
  // Existing actual service database, exposed ONLY to this fixture observer.
  const db = (service as unknown as { db: Database.Database }).db;
  const prepare = db.prepare;
  vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
    const statement = Reflect.apply(prepare, db, [sql]);
    if (
      sql ===
      'UPDATE repository_workspaces SET record=? WHERE id=? AND record=? AND conversation_id IS NULL'
    ) {
      const run = statement.run;
      vi.spyOn(statement, 'run').mockImplementation((...args: unknown[]) => {
        cas.calls++;
        const result = diagnostics.captureSync('row-cas', () =>
          Reflect.apply(run, statement, args),
        );
        cas.returned++;
        if (result.changes === 0) cas.zeroChanges++;
        return result;
      });
    }
    return statement;
  });
  return () => structuredClone({ receipt, cas });
}
